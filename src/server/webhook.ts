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

/** Bounded window for Twilio MessageSid replay/retry dedupe (Twilio retries the same delivery). */
const SID_DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const SID_DEDUPE_MAX_ENTRIES = 10_000;

function pruneDedupe(seen: Map<string, number>, now: number): void {
  if (seen.size <= SID_DEDUPE_MAX_ENTRIES) return;
  for (const [key, at] of seen) {
    if (now - at > SID_DEDUPE_WINDOW_MS) seen.delete(key);
  }
}

/** Fail safely: never let a request crash the process. Response errors are swallowed (the socket
 * is already gone); handler errors get a 500 when the socket is still writable, otherwise we just
 * stop -- there's nothing left to respond to. */
function respondSafely(res: ServerResponse, status: number, contentType: string, text: string): void {
  if (res.writableEnded || res.destroyed) return;
  try {
    res.writeHead(status, { 'content-type': contentType }).end(text);
  } catch {
    // Socket died between the check and the write; nothing more to do.
  }
}

export function startWebhookServer(opts: WebhookOptions): WebhookServer {
  const seenSids = new Map<string, number>();
  const inFlightSids = new Set<string>();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // A client that disconnects mid-body raises 'error'/'aborted' on the request (and sometimes
    // 'error' on the response once it tries to write back). With no listener, Node's default
    // behavior for an EventEmitter 'error' with no handler is to throw synchronously and crash the
    // process, so these no-op listeners alone are load-bearing, independent of the promise chain.
    req.on('error', () => {});
    req.on('aborted', () => {});
    res.on('error', () => {});
    handle(req, res, opts, seenSids, inFlightSids).catch(() => {
      respondSafely(res, 500, 'text/plain', 'internal error');
    });
  });
  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  server.listen(opts.port);
  return {
    server,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  opts: WebhookOptions,
  seenSids: Map<string, number>,
  inFlightSids: Set<string>,
): Promise<void> {
  if (req.method !== 'POST') {
    respondSafely(res, 404, 'text/plain', 'not found');
    return;
  }
  let body: string;
  try {
    body = await readBody(req);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      respondSafely(res, 413, 'text/plain', 'payload too large');
      return;
    }
    // Client disconnected mid-body (socket 'error'/'aborted' surfaced through the async iterator):
    // nothing to respond to if the socket is already gone, otherwise a plain 400 clean-up.
    respondSafely(res, 400, 'text/plain', 'bad request');
    return;
  }
  const params = parseForm(body);
  const signature = req.headers['x-twilio-signature'];
  const expected = twilioSignature(opts.publicUrl, params, opts.authToken);
  if (typeof signature !== 'string' || !safeEqual(signature, expected)) {
    respondSafely(res, 403, 'text/plain', 'invalid signature');
    return;
  }
  const sid = params.MessageSid ?? params.SmsSid ?? '';
  const now = Date.now();
  const alreadyDone = sid !== '' && seenSids.has(sid);
  const alreadyInFlight = sid !== '' && inFlightSids.has(sid);
  if (alreadyDone || alreadyInFlight) {
    // Already processed (or a concurrent delivery of the same sid is still processing): no-op ack.
    respondSafely(res, 200, 'text/xml', EMPTY_TWIML);
    return;
  }
  if (sid !== '') inFlightSids.add(sid);
  try {
    await opts.onMessage(toTextMessage(params));
  } catch (err) {
    if (sid !== '') inFlightSids.delete(sid);
    // Do not ack: Twilio must see a failure so it retries and the message isn't lost.
    throw err;
  }
  if (sid !== '') {
    inFlightSids.delete(sid);
    seenSids.set(sid, now);
    pruneDedupe(seenSids, now);
  }
  respondSafely(res, 200, 'text/xml', EMPTY_TWIML);
}
