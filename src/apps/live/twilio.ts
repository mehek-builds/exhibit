import { safeErrorBody } from '../../integrations/types.js';
import type { TextMessage, TwilioApi } from '../types.js';
import type { HttpTransport } from '../../integrations/types.js';
import { FetchTransport } from '../../integrations/types.js';

// Live Twilio Programmable Messaging adapter (PRD 6.13, 7.3): SMS in the Arga twin, WhatsApp
// Sandbox live. POST/GET against api.twilio.com with HTTP basic auth (Account SID + auth token);
// `transport` is swappable for a FixtureTransport in tests, same pattern as src/apps/live/google.ts.
//
// Trial limits this adapter must respect at call sites, not enforce itself (PRD 6.13):
//   - WhatsApp Sandbox: only within the 24-hour customer-service window after an inbound message,
//     unless using a pre-approved template.
//   - Rate limit: about 1 message per 3 seconds per sender in trial.
//   - SMS trial: only pre-approved template bodies to unverified numbers.

export interface TwilioApiOptions {
  accountSid: string;
  authToken: string;
  /** 'whatsapp:+14155238886' for the Sandbox, or a bare E.164 number for SMS. */
  sender: string;
  transport?: HttpTransport;
  /** Minimum gap enforced between two `send()` calls, honoring the trial rate limit above. Default 3000ms. */
  minSendIntervalMs?: number;
  /** Injectable clock/sleep so tests can assert the wait without actually waiting. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function basicAuth(sid: string, token: string): string {
  return `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`;
}

function normalize(addr: string): string {
  return addr.startsWith('whatsapp:') ? addr : addr;
}

function form(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

interface TwilioMessageJson {
  sid: string;
  from: string;
  to: string;
  body: string;
  direction: string;
  date_sent: string | null;
  date_created: string;
}

function channelFor(addr: string): 'sms' | 'whatsapp' {
  return addr.startsWith('whatsapp:') ? 'whatsapp' : 'sms';
}

function mapMessage(m: TwilioMessageJson): TextMessage {
  return {
    sid: m.sid,
    from: normalize(m.from),
    to: normalize(m.to),
    body: m.body,
    direction: m.direction === 'inbound' ? 'inbound' : 'outbound',
    channel: channelFor(m.to),
    dateSent: m.date_sent ?? m.date_created,
  };
}

export function createTwilioApi(opts: TwilioApiOptions): TwilioApi {
  const transport = opts.transport ?? new FetchTransport();
  const base = `https://api.twilio.com/2010-04-01/Accounts/${opts.accountSid}`;
  const auth = basicAuth(opts.accountSid, opts.authToken);
  const minSendIntervalMs = opts.minSendIntervalMs ?? 3000;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastSendAt: number | null = null;
  // Serialize sends through a promise chain: concurrent callers queue behind each other so the
  // throttle's read-then-write of lastSendAt is never racing another send. Each link awaits its
  // own throttle wait + request; a failure in one send must not break the chain for later sends,
  // so the chain link always resolves (never rejects) and the underlying error/result is
  // re-thrown/returned from the per-caller wrapper instead.
  let sendChain: Promise<void> = Promise.resolve();

  async function doSend(message: { to: string; body: string }): Promise<{ sid: string }> {
    // Trial rate limit (~1 message per 3s per sender, see module doc above): never enforced by
    // Twilio's own client, so this adapter self-throttles at the send path.
    if (lastSendAt !== null) {
      const elapsed = now() - lastSendAt;
      if (elapsed < minSendIntervalMs) await sleep(minSendIntervalMs - elapsed);
    }
    lastSendAt = now();

    const to = message.to.startsWith('whatsapp:') || opts.sender.startsWith('whatsapp:') ? (message.to.startsWith('whatsapp:') ? message.to : `whatsapp:${message.to}`) : message.to;
    const res = await transport.request({
      method: 'POST',
      url: `${base}/Messages.json`,
      headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ To: to, From: opts.sender, Body: message.body }),
    });
    if (res.status >= 300) throw new Error(`twilio send failed: ${res.status} ${safeErrorBody(res.body)}`);
    const parsed = JSON.parse(res.body) as TwilioMessageJson;
    return { sid: parsed.sid };
  }

  return {
    sender: opts.sender,

    async send(message) {
      const previous = sendChain;
      let release!: () => void;
      sendChain = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await doSend(message);
      } finally {
        release();
      }
    },

    async listInbound() {
      const out: TextMessage[] = [];
      let url = `${base}/Messages.json?To=${encodeURIComponent(opts.sender)}&PageSize=100`;
      for (let page = 0; page < 50 && url; page++) {
        const res = await transport.request({ method: 'GET', url, headers: { authorization: auth } });
        if (res.status >= 300) throw new Error(`twilio listInbound failed: ${res.status} ${safeErrorBody(res.body)}`);
        const parsed = JSON.parse(res.body) as { messages: TwilioMessageJson[]; next_page_uri: string | null };
        for (const m of parsed.messages) if (m.direction === 'inbound') out.push(mapMessage(m));
        url = parsed.next_page_uri ? `https://api.twilio.com${parsed.next_page_uri}` : '';
      }
      return out.sort((a, b) => Date.parse(a.dateSent) - Date.parse(b.dateSent));
    },
  };
}
