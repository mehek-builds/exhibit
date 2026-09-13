import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FixtureTransport } from '../src/integrations/types.js';
import { createTwilioApi } from '../src/apps/live/twilio.js';
import { twilioSignature } from '../src/server/webhook.js';

// FixtureTransport tests for the live Twilio adapter (send/list) and webhook signature validation
// against a known-good vector computed here from the documented algorithm (PRD 6.13, 7.3).

describe('twilio live adapter: send', () => {
  it('POSTs form-encoded To/From/Body with basic auth', async () => {
    const fixture = new FixtureTransport({
      'POST https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json': {
        status: 201,
        headers: {},
        body: JSON.stringify({ sid: 'SM999', from: 'whatsapp:+14155238886', to: 'whatsapp:+15550100142', body: 'hi', direction: 'outbound-api', date_sent: null, date_created: '2026-09-13T12:00:00Z' }),
      },
    });
    const api = createTwilioApi({ accountSid: 'AC123', authToken: 'tok', sender: 'whatsapp:+14155238886', transport: fixture });
    const res = await api.send({ to: '+15550100142', body: 'hi' });
    expect(res.sid).toBe('SM999');
    expect(fixture.requests).toHaveLength(1);
    const req = fixture.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.headers?.authorization).toBe(`Basic ${Buffer.from('AC123:tok').toString('base64')}`);
    const body = String(req.body);
    expect(body).toContain('To=whatsapp%3A%2B15550100142');
    expect(body).toContain('From=whatsapp%3A%2B14155238886');
    expect(body).toContain('Body=hi');
  });

  it('throws on a non-2xx response', async () => {
    const fixture = new FixtureTransport({
      'POST https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json': { status: 400, headers: {}, body: '{"message":"bad"}' },
    });
    const api = createTwilioApi({ accountSid: 'AC123', authToken: 'tok', sender: '+15550100000', transport: fixture });
    await expect(api.send({ to: '+15550100142', body: 'hi' })).rejects.toThrow(/twilio send failed/);
  });
});

describe('twilio live adapter: listInbound', () => {
  it('paginates and returns only inbound messages, normalized', async () => {
    const page1 = {
      messages: [
        { sid: 'SM1', from: 'whatsapp:+15550100142', to: 'whatsapp:+14155238886', body: 'APPROVE LTR-1', direction: 'inbound', date_sent: '2026-09-01T00:00:00Z', date_created: '2026-09-01T00:00:00Z' },
        { sid: 'SM2', from: 'whatsapp:+14155238886', to: 'whatsapp:+15550100142', body: 'sent by us', direction: 'outbound-api', date_sent: '2026-09-02T00:00:00Z', date_created: '2026-09-02T00:00:00Z' },
      ],
      next_page_uri: '/2010-04-01/Accounts/AC123/Messages.json?Page=1',
    };
    const page2 = {
      messages: [
        { sid: 'SM3', from: 'whatsapp:+15550100142', to: 'whatsapp:+14155238886', body: 'STOP', direction: 'inbound', date_sent: '2026-09-03T00:00:00Z', date_created: '2026-09-03T00:00:00Z' },
      ],
      next_page_uri: null,
    };
    const fixture = new FixtureTransport({
      'GET https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json': (req) =>
        req.url.includes('Page=1') ? { status: 200, headers: {}, body: JSON.stringify(page2) } : { status: 200, headers: {}, body: JSON.stringify(page1) },
    });
    const api = createTwilioApi({ accountSid: 'AC123', authToken: 'tok', sender: 'whatsapp:+14155238886', transport: fixture });
    const inbound = await api.listInbound();
    expect(inbound.map((m) => m.sid)).toEqual(['SM1', 'SM3']);
    expect(inbound.every((m) => m.direction === 'inbound')).toBe(true);
    expect(inbound[0]!.channel).toBe('whatsapp');
  });
});

describe('twilioSignature', () => {
  it('matches a known-good vector computed from the documented algorithm', () => {
    // https://www.twilio.com/docs/usage/security#validating-requests
    const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
    const params = { CallSid: 'CA1234567890ABCDE', Caller: '+14158675310', Digits: '1234', From: '+14158675310', To: '+18005551212' };
    const authToken = '12345';
    let data = url;
    for (const k of Object.keys(params).sort()) data += k + (params as Record<string, string>)[k];
    const expected = createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
    expect(twilioSignature(url, params, authToken)).toBe(expected);
  });
});

describe('webhook: startWebhookServer signature validation', () => {
  it('rejects an invalid signature with 403 and never calls onMessage', async () => {
    const { startWebhookServer } = await import('../src/server/webhook.js');
    const authToken = 'test-token';
    const publicUrl = 'http://127.0.0.1:0/twilio'; // placeholder; overwritten below with the real port
    let called = false;
    const port = await freePort();
    const realUrl = `http://127.0.0.1:${port}/twilio`;
    const server = startWebhookServer({ port, authToken, publicUrl: realUrl, onMessage: () => { called = true; } });
    try {
      const body = 'From=%2B15550100142&Body=hi&MessageSid=SM1';
      const res = await fetch(realUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'not-valid' }, body });
      expect(res.status).toBe(403);
      expect(called).toBe(false);
    } finally {
      await server.close();
    }
    void publicUrl;
  });

  it('accepts a valid signature and delivers the message', async () => {
    const { startWebhookServer } = await import('../src/server/webhook.js');
    const authToken = 'test-token';
    const port = await freePort();
    const realUrl = `http://127.0.0.1:${port}/twilio`;
    let received: unknown = null;
    const server = startWebhookServer({
      port,
      authToken,
      publicUrl: realUrl,
      onMessage: (msg) => {
        received = msg;
      },
    });
    try {
      const params: Record<string, string> = { From: '+15550100142', To: 'whatsapp:+14155238886', Body: 'hi', MessageSid: 'SM1' };
      const sig = twilioSignature(realUrl, params, authToken);
      const body = new URLSearchParams(params).toString();
      const res = await fetch(realUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig }, body });
      expect(res.status).toBe(200);
      expect((res.headers.get('content-type') ?? '')).toContain('text/xml');
      expect(received).toMatchObject({ sid: 'SM1', from: '+15550100142', body: 'hi', direction: 'inbound' });
    } finally {
      await server.close();
    }
  });
});

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
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
