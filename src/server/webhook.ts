import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { TextMessage } from '../apps/types.js';

// Twilio inbound-message webhook (PRD 6.13). Validates `X-Twilio-Signature` (HMAC-SHA1 over the
// full URL plus every POST param, key-sorted, concatenated with no delimiter, base64-encoded), per
// https://www.twilio.com/docs/usage/security#validating-requests. Invalid signatures get a 403 and
// are never handed to `onMessage`.

/** The documented Twilio signature algorithm, exported for tests to build known-good vectors. */
export function twilioSignature(url: string, params: Record<string, string>, authToken: string): string {
  const sorted = Object.keys(params).sort();
  let data = url;
  for (const k of sorted) data += k + params[k];
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Twilio webhook posts are small; anything larger is rejected before the signature check runs. */
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

export class BodyTooLargeError extends Error {
  constructor() {
    super(`webhook body exceeds ${MAX_WEBHOOK_BODY_BYTES} bytes`);
    this.name = 'BodyTooLargeError';
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_WEBHOOK_BODY_BYTES) throw new BodyTooLargeError();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength;
    if (size > MAX_WEBHOOK_BODY_BYTES) {
      req.destroy();
      throw new BodyTooLargeError();
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseForm(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of body.split('&')) {
    if (!pair) continue;
    const [k = '', v = ''] = pair.split('=');
    out[decodeURIComponent(k.replace(/\+/g, ' '))] = decodeURIComponent(v.replace(/\+/g, ' '));
  }
  return out;
}

function toTextMessage(params: Record<string, string>): TextMessage {
  const from = params.From ?? '';
  return {
    sid: params.MessageSid ?? params.SmsSid ?? '',
    from,
    to: params.To ?? '',
    body: params.Body ?? '',
    direction: 'inbound',
    channel: from.startsWith('whatsapp:') ? 'whatsapp' : 'sms',
    dateSent: new Date().toISOString(),
  };
}

export interface WebhookOptions {
  port: number;
  authToken: string;
  /** Public base URL Twilio was configured with, e.g. 'https://exhibit.example.com/twilio'. Used to reconstruct the exact signed URL. */
  publicUrl: string;
  onMessage: (msg: TextMessage) => void | Promise<void>;
}

export interface WebhookServer {
  server: Server;
  close(): Promise<void>;
}

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

export function startWebhookServer(opts: WebhookOptions): WebhookServer {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res, opts);
  });
  server.listen(opts.port);
  return {
    server,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

async function handle(req: IncomingMessage, res: ServerResponse, opts: WebhookOptions): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(404).end();
    return;
  }
  let body: string;
  try {
    body = await readBody(req);
  } catch (err) {
    if (!(err instanceof BodyTooLargeError)) throw err;
    res.writeHead(413, { 'content-type': 'text/plain' }).end('payload too large');
    return;
  }
  const params = parseForm(body);
  const signature = req.headers['x-twilio-signature'];
  const expected = twilioSignature(opts.publicUrl, params, opts.authToken);
  if (typeof signature !== 'string' || !safeEqual(signature, expected)) {
    res.writeHead(403, { 'content-type': 'text/plain' }).end('invalid signature');
    return;
  }
  try {
    await opts.onMessage(toTextMessage(params));
  } catch {
    // The webhook must still ack Twilio; failures are handled by the notifier/text channel, not here.
  }
  res.writeHead(200, { 'content-type': 'text/xml' }).end(EMPTY_TWIML);
}
