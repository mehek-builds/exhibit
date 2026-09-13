import { describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
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

const SECRET = 'test-secret';
const FOUNDER_EMAIL = 'founder@example.com';

function createdEvent(id: string) {
  return JSON.stringify({ type: 'issue.created', issue: { id, title: 'Gmail send never approved', failureMode: 'approval loop stuck', traceUrl: 'https://lemma.example/trace/1' } });
}

function resolvedEvent(id: string) {
  return JSON.stringify({ type: 'issue.resolved', issue: { id, title: 'Gmail send never approved', failureMode: 'approval loop stuck', traceUrl: 'https://lemma.example/trace/1' } });
}

async function withServer<T>(founderEmail: string, run: (url: string, sent: { to: string; subject: string; body: string }[]) => Promise<T>): Promise<T> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/lemma`;
  const sent: { to: string; subject: string; body: string }[] = [];
  const server = startLemmaWebhookServer({
    port,
    secret: SECRET,
    founderEmail,
    sendEmail: async (email) => {
      sent.push(email);
      return { id: 'm1' };
    },
  });
  try {
    return await run(url, sent);
  } finally {
    await server.close();
  }
}

describe('lemma issue webhook', () => {
  it('rejects a bad signature with 401 and sends no email', async () => {
    await withServer(FOUNDER_EMAIL, async (url, sent) => {
      const res = await fetch(url, { method: 'POST', headers: { 'x-lemma-signature': 'not-valid' }, body: createdEvent('ISS-1') });
      expect(res.status).toBe(401);
      expect(sent).toHaveLength(0);
    });
  });

  it('rejects an oversized body with 413', async () => {
    await withServer(FOUNDER_EMAIL, async (url, sent) => {
      const huge = 'x'.repeat(70 * 1024);
      const res = await fetch(url, { method: 'POST', headers: { 'content-length': String(Buffer.byteLength(huge)) }, body: huge });
      expect(res.status).toBe(413);
      expect(sent).toHaveLength(0);
    });
  });

  it('a valid issue.created sends exactly one email to the founder with title, failure mode and trace link', async () => {
    await withServer(FOUNDER_EMAIL, async (url, sent) => {
      const body = createdEvent('ISS-1');
      const sig = lemmaSignature(body, SECRET);
      const res = await fetch(url, { method: 'POST', headers: { 'x-lemma-signature': sig }, body });
      expect(res.status).toBe(200);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.to).toBe(FOUNDER_EMAIL);
      expect(sent[0]!.subject).toContain('Gmail send never approved');
      expect(sent[0]!.body).toContain('approval loop stuck');
      expect(sent[0]!.body).toContain('https://lemma.example/trace/1');
    });
  });

  it('a valid issue.resolved sends exactly one email to the founder', async () => {
    await withServer(FOUNDER_EMAIL, async (url, sent) => {
      const body = resolvedEvent('ISS-1');
      const sig = lemmaSignature(body, SECRET);
      const res = await fetch(url, { method: 'POST', headers: { 'x-lemma-signature': sig }, body });
      expect(res.status).toBe(200);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.to).toBe(FOUNDER_EMAIL);
      expect(sent[0]!.subject).toContain('resolved');
    });
  });

  it('the recipient can never be changed by the payload, even if the payload tries', async () => {
    await withServer(FOUNDER_EMAIL, async (url, sent) => {
      const malicious = JSON.stringify({
        type: 'issue.created',
        to: 'attacker@evil.example',
        founderEmail: 'attacker@evil.example',
        issue: { id: 'ISS-2', title: 'x', failureMode: 'y', traceUrl: 'z', to: 'attacker@evil.example' },
      });
      const sig = lemmaSignature(malicious, SECRET);
      const res = await fetch(url, { method: 'POST', headers: { 'x-lemma-signature': sig }, body: malicious });
      expect(res.status).toBe(200);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.to).toBe(FOUNDER_EMAIL);
    });
  });
});
