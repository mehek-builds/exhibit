import { describe, expect, it } from 'vitest';
import { connect, createServer } from 'node:net';
import { startWebhookServer, twilioSignature } from '../src/server/webhook.js';
import { lemmaSignature, startLemmaWebhookServer } from '../src/server/lemmaWebhook.js';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Writes a partial (headers-only, no body) HTTP POST over a raw socket, then destroys it mid-body
 * -- reproducing a client that disconnects before the body finishes. */
async function sendPartialThenDestroy(port: number, path: string, declaredLength: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${declaredLength}\r\nContent-Type: application/x-www-form-urlencoded\r\n\r\n`);
      socket.write('partial-body-not-'); // fewer bytes than declaredLength
      socket.once('error', () => resolve()); // ECONNRESET etc. from our own destroy is expected
      setTimeout(() => {
        socket.destroy();
        resolve();
      }, 50);
    });
    socket.once('error', reject);
  });
}

describe('webhook resilience: mid-body disconnects never crash the server', () => {
  it('Twilio webhook survives a destroyed socket and keeps serving', async () => {
    const port = await freePort();
    const unhandledRejections: unknown[] = [];
    const uncaughtExceptions: unknown[] = [];
    const onRejection = (err: unknown) => unhandledRejections.push(err);
    const onException = (err: unknown) => uncaughtExceptions.push(err);
    process.on('unhandledRejection', onRejection);
    process.on('uncaughtException', onException);

    const received: string[] = [];
    const authToken = 'twilio-secret';
    const publicUrl = `http://127.0.0.1:${port}/twilio`;
    const webhook = startWebhookServer({
      port,
      authToken,
      publicUrl,
      onMessage: (msg) => {
        received.push(msg.sid);
      },
    });

    try {
      await sendPartialThenDestroy(port, '/twilio', 1000);
      // Give the server a tick to process the abort.
      await new Promise((r) => setTimeout(r, 100));

      const params = { From: '+15550001111', To: '+15550002222', Body: 'hi', MessageSid: 'SM123' };
      const sig = twilioSignature(publicUrl, params, authToken);
      const body = new URLSearchParams(params).toString();
      const res = await fetch(publicUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig },
        body,
      });
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 20));
      expect(received).toEqual(['SM123']);
    } finally {
      process.off('unhandledRejection', onRejection);
      process.off('uncaughtException', onException);
      await webhook.close();
    }

    expect(unhandledRejections).toEqual([]);
    expect(uncaughtExceptions).toEqual([]);
  });

  it('Lemma webhook survives a destroyed socket and keeps serving', async () => {
    const port = await freePort();
    const unhandledRejections: unknown[] = [];
    const uncaughtExceptions: unknown[] = [];
    const onRejection = (err: unknown) => unhandledRejections.push(err);
    const onException = (err: unknown) => uncaughtExceptions.push(err);
    process.on('unhandledRejection', onRejection);
    process.on('uncaughtException', onException);

    const secret = 'lemma-secret';
    const sent: { to: string }[] = [];
    const webhook = startLemmaWebhookServer({
      port,
      secret,
      founderEmail: 'founder@example.com',
      sendEmail: async (email) => {
        sent.push(email);
        return { id: 'm1' };
      },
    });

    try {
      await sendPartialThenDestroy(port, '/lemma', 1000);
      await new Promise((r) => setTimeout(r, 100));

      const body = JSON.stringify({ type: 'issue.created', issue: { id: 'ISS-1', title: 't', failureMode: 'f', traceUrl: 'u' } });
      const sig = lemmaSignature(body, secret);
      const res = await fetch(`http://127.0.0.1:${port}/lemma`, {
        method: 'POST',
        headers: { 'x-lemma-signature': sig },
        body,
      });
      expect(res.status).toBe(200);
      expect(sent).toHaveLength(1);
    } finally {
      process.off('unhandledRejection', onRejection);
      process.off('uncaughtException', onException);
      await webhook.close();
    }

    expect(unhandledRejections).toEqual([]);
    expect(uncaughtExceptions).toEqual([]);
  });
});

describe('replay/retry dedupe', () => {
  it('a replayed, validly-signed Lemma request sends exactly one email total', async () => {
    const port = await freePort();
    const secret = 'lemma-secret';
    const sent: { to: string }[] = [];
    const webhook = startLemmaWebhookServer({
      port,
      secret,
      founderEmail: 'founder@example.com',
      sendEmail: async (email) => {
        sent.push(email);
        return { id: 'm1' };
      },
    });
    try {
      const body = JSON.stringify({ type: 'issue.created', issue: { id: 'ISS-9', title: 't', failureMode: 'f', traceUrl: 'u' } });
      const sig = lemmaSignature(body, secret);
      const url = `http://127.0.0.1:${port}/lemma`;
      const res1 = await fetch(url, { method: 'POST', headers: { 'x-lemma-signature': sig }, body });
      const res2 = await fetch(url, { method: 'POST', headers: { 'x-lemma-signature': sig }, body });
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(sent).toHaveLength(1);
    } finally {
      await webhook.close();
    }
  });

  it('a duplicate Twilio MessageSid is processed exactly once', async () => {
    const port = await freePort();
    const authToken = 'twilio-secret';
    const publicUrl = `http://127.0.0.1:${port}/twilio`;
    const received: string[] = [];
    const webhook = startWebhookServer({
      port,
      authToken,
      publicUrl,
      onMessage: (msg) => {
        received.push(msg.sid);
      },
    });
    try {
      const params = { From: '+15550001111', To: '+15550002222', Body: 'hi', MessageSid: 'SM999' };
      const sig = twilioSignature(publicUrl, params, authToken);
      const body = new URLSearchParams(params).toString();
      const opts = { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig }, body };
      const res1 = await fetch(publicUrl, opts);
      const res2 = await fetch(publicUrl, opts);
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      await new Promise((r) => setTimeout(r, 20));
      expect(received).toEqual(['SM999']);
    } finally {
      await webhook.close();
    }
  });
});

describe('failed processing does not poison the retry', () => {
  it('Twilio: first onMessage throws, retry with the same MessageSid is processed exactly once', async () => {
    const port = await freePort();
    const authToken = 'twilio-secret';
    const publicUrl = `http://127.0.0.1:${port}/twilio`;
    const received: string[] = [];
    let calls = 0;
    const webhook = startWebhookServer({
      port,
      authToken,
      publicUrl,
      onMessage: (msg) => {
        calls++;
        if (calls === 1) throw new Error('boom');
        received.push(msg.sid);
      },
    });
    try {
      const params = { From: '+15550001111', To: '+15550002222', Body: 'hi', MessageSid: 'SM-RETRY-1' };
      const sig = twilioSignature(publicUrl, params, authToken);
      const body = new URLSearchParams(params).toString();
      const opts = { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig }, body };
      const res1 = await fetch(publicUrl, opts);
      expect(res1.status).toBe(500);
      const res2 = await fetch(publicUrl, opts);
      expect(res2.status).toBe(200);
      expect(received).toEqual(['SM-RETRY-1']);
      expect(calls).toBe(2);
    } finally {
      await webhook.close();
    }
  });

  it('Twilio: two concurrent deliveries of the same sid are processed once', async () => {
    const port = await freePort();
    const authToken = 'twilio-secret';
    const publicUrl = `http://127.0.0.1:${port}/twilio`;
    const received: string[] = [];
    let calls = 0;
    const webhook = startWebhookServer({
      port,
      authToken,
      publicUrl,
      onMessage: async (msg) => {
        calls++;
        await new Promise((r) => setTimeout(r, 50));
        received.push(msg.sid);
      },
    });
    try {
      const params = { From: '+15550001111', To: '+15550002222', Body: 'hi', MessageSid: 'SM-CONCUR-1' };
      const sig = twilioSignature(publicUrl, params, authToken);
      const body = new URLSearchParams(params).toString();
      const opts = { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig }, body };
      const [res1, res2] = await Promise.all([fetch(publicUrl, opts), fetch(publicUrl, opts)]);
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(calls).toBe(1);
      expect(received).toEqual(['SM-CONCUR-1']);
    } finally {
      await webhook.close();
    }
  });

  it('Twilio: a successful delivery followed by a duplicate is processed once', async () => {
    const port = await freePort();
    const authToken = 'twilio-secret';
    const publicUrl = `http://127.0.0.1:${port}/twilio`;
    const received: string[] = [];
    const webhook = startWebhookServer({
      port,
      authToken,
      publicUrl,
      onMessage: (msg) => {
        received.push(msg.sid);
      },
    });
    try {
      const params = { From: '+15550001111', To: '+15550002222', Body: 'hi', MessageSid: 'SM-DUP-1' };
      const sig = twilioSignature(publicUrl, params, authToken);
      const body = new URLSearchParams(params).toString();
      const opts = { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig }, body };
      const res1 = await fetch(publicUrl, opts);
      const res2 = await fetch(publicUrl, opts);
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(received).toEqual(['SM-DUP-1']);
    } finally {
      await webhook.close();
    }
  });

  it('Lemma: first send fails, retry with the same event is processed exactly once successfully', async () => {
    const port = await freePort();
    const secret = 'lemma-secret';
    const sent: { to: string }[] = [];
    let calls = 0;
    const webhook = startLemmaWebhookServer({
      port,
      secret,
      founderEmail: 'founder@example.com',
      sendEmail: async (email) => {
        calls++;
        if (calls === 1) throw new Error('smtp down');
        sent.push(email);
        return { id: 'm1' };
      },
    });
    try {
      const body = JSON.stringify({ type: 'issue.created', issue: { id: 'ISS-RETRY-1', title: 't', failureMode: 'f', traceUrl: 'u' } });
      const sig = lemmaSignature(body, secret);
      const url = `http://127.0.0.1:${port}/lemma`;
      const opts = { method: 'POST', headers: { 'x-lemma-signature': sig }, body };
      const res1 = await fetch(url, opts);
      expect(res1.status).toBe(500);
      const res2 = await fetch(url, opts);
      expect(res2.status).toBe(200);
      expect(sent).toHaveLength(1);
      expect(calls).toBe(2);
    } finally {
      await webhook.close();
    }
  });

  it('Lemma: two concurrent deliveries of the same event are processed once', async () => {
    const port = await freePort();
    const secret = 'lemma-secret';
    const sent: { to: string }[] = [];
    let calls = 0;
    const webhook = startLemmaWebhookServer({
      port,
      secret,
      founderEmail: 'founder@example.com',
      sendEmail: async (email) => {
        calls++;
        await new Promise((r) => setTimeout(r, 50));
        sent.push(email);
        return { id: 'm1' };
      },
    });
    try {
      const body = JSON.stringify({ type: 'issue.created', issue: { id: 'ISS-CONCUR-1', title: 't', failureMode: 'f', traceUrl: 'u' } });
      const sig = lemmaSignature(body, secret);
      const url = `http://127.0.0.1:${port}/lemma`;
      const opts = { method: 'POST', headers: { 'x-lemma-signature': sig }, body };
      const [res1, res2] = await Promise.all([fetch(url, opts), fetch(url, opts)]);
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(calls).toBe(1);
      expect(sent).toHaveLength(1);
    } finally {
      await webhook.close();
    }
  });

  it('Lemma: a successful delivery followed by a duplicate is processed once', async () => {
    const port = await freePort();
    const secret = 'lemma-secret';
    const sent: { to: string }[] = [];
    const webhook = startLemmaWebhookServer({
      port,
      secret,
      founderEmail: 'founder@example.com',
      sendEmail: async (email) => {
        sent.push(email);
        return { id: 'm1' };
      },
    });
    try {
      const body = JSON.stringify({ type: 'issue.created', issue: { id: 'ISS-DUP-1', title: 't', failureMode: 'f', traceUrl: 'u' } });
      const sig = lemmaSignature(body, secret);
      const url = `http://127.0.0.1:${port}/lemma`;
      const opts = { method: 'POST', headers: { 'x-lemma-signature': sig }, body };
      const res1 = await fetch(url, opts);
      const res2 = await fetch(url, opts);
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(sent).toHaveLength(1);
    } finally {
      await webhook.close();
    }
  });
});
