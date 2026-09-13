import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { redactText } from '../pipeline/redact.js';

// Lemma issue webhooks (PRD 6.10, 7.2): `issue.created` and `issue.resolved` post to the founder's
// own inbox during the build. Modeled directly on src/server/webhook.ts (the Twilio webhook): same
// body-size cap, same reject-before-signature-check ordering, same "never throw past the handler"
// shape. The one thing this module is stricter about is the recipient -- it is fixed at
// construction time from the founder's own profile email and nothing in the payload can change it,
// because a forged or malformed event body must never be able to redirect where the notification
// goes.
//
// Signature scheme: Lemma is not prescriptive here (7.2 only says "package @uselemma/tracing"), so
// this verifies an HMAC-SHA256 over the raw request body, hex-encoded, in an `X-Lemma-Signature`
// header, keyed by LEMMA_WEBHOOK_SECRET (.env.example). This is the same shape Lemma's own docs use
// for outbound webhooks; if the real header/algorithm differs once Lemma is wired up for real, only
// `lemmaSignature`/`verifySignature` below need to change.

export const MAX_LEMMA_WEBHOOK_BODY_BYTES = 64 * 1024;

export class LemmaBodyTooLargeError extends Error {
  constructor() {
    super(`Lemma webhook body exceeds ${MAX_LEMMA_WEBHOOK_BODY_BYTES} bytes`);
    this.name = 'LemmaBodyTooLargeError';
  }
}

export interface LemmaIssueEvent {
  type: 'issue.created' | 'issue.resolved';
  issue: {
    id: string;
    title: string;
    /** Short description of what went wrong, e.g. "email misclassified as spam". */
    failureMode: string;
    /** Link to the Lemma trace/issue in their UI. */
    traceUrl: string;
  };
}

/** HMAC-SHA256 over the raw body, hex-encoded -- exported so tests can build known-good vectors. */
export function lemmaSignature(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_LEMMA_WEBHOOK_BODY_BYTES) throw new LemmaBodyTooLargeError();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength;
    if (size > MAX_LEMMA_WEBHOOK_BODY_BYTES) {
      req.destroy();
      throw new LemmaBodyTooLargeError();
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseEvent(body: string): LemmaIssueEvent | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    if (p.type !== 'issue.created' && p.type !== 'issue.resolved') return null;
    const issue = p.issue as Record<string, unknown> | undefined;
    if (!issue || typeof issue.id !== 'string' || typeof issue.title !== 'string') return null;
    return {
      type: p.type,
      issue: {
        id: issue.id,
        title: issue.title,
        failureMode: typeof issue.failureMode === 'string' ? issue.failureMode : '',
        traceUrl: typeof issue.traceUrl === 'string' ? issue.traceUrl : '',
      },
    };
  } catch {
    return null;
  }
}

export interface LemmaWebhookOptions {
  port: number;
  /** LEMMA_WEBHOOK_SECRET; the shared secret used to verify X-Lemma-Signature. */
  secret: string;
  /** The founder's own address (profile.emails[0]). Never overridable by the payload. */
  founderEmail: string;
  /** Sends one email; wired to apps.gmail.send by the caller so this module stays test-friendly. */
  sendEmail: (email: { to: string; subject: string; body: string }) => Promise<{ id: string }>;
}

export interface LemmaWebhookServer {
  server: Server;
  close(): Promise<void>;
}

/** Bounded window for Lemma replay dedupe. Lemma's webhook docs (see docs/integrations/LEMMA.md)
 * specify only `X-Lemma-Signature`; there is no delivery id or timestamp header to key off, so we
 * dedupe on the event identity (type + issue id) plus a hash of the signed raw body -- a captured,
 * validly-signed request replayed later is rejected instead of emailing the founder again. */
const REPLAY_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
const REPLAY_DEDUPE_MAX_ENTRIES = 10_000;

function replayKey(event: LemmaIssueEvent, rawBody: string): string {
  const bodyHash = createHash('sha256').update(rawBody, 'utf8').digest('hex');
  return `${event.type}:${event.issue.id}:${bodyHash}`;
}

function pruneDedupe(seen: Map<string, number>, now: number): void {
  if (seen.size <= REPLAY_DEDUPE_MAX_ENTRIES) return;
  for (const [key, at] of seen) {
    if (now - at > REPLAY_DEDUPE_WINDOW_MS) seen.delete(key);
  }
}

function respondSafely(res: ServerResponse, status: number, contentType: string, text: string): void {
  if (res.writableEnded || res.destroyed) return;
  try {
    res.writeHead(status, { 'content-type': contentType }).end(text);
  } catch {
    // Socket died between the check and the write; nothing more to do.
  }
}

export function startLemmaWebhookServer(opts: LemmaWebhookOptions): LemmaWebhookServer {
  const seenEvents = new Map<string, number>();
  const inFlightEvents = new Set<string>();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // See webhook.ts for why these no-op listeners are load-bearing: an EventEmitter 'error' with
    // no listener throws synchronously and crashes the process, independent of the promise chain.
    req.on('error', () => {});
    req.on('aborted', () => {});
    res.on('error', () => {});
    handle(req, res, opts, seenEvents, inFlightEvents).catch(() => {
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

function emailFor(event: LemmaIssueEvent): { subject: string; body: string } {
  const verb = event.type === 'issue.created' ? 'New Lemma issue' : 'Lemma issue resolved';
  const title = redactText(event.issue.title).text;
  const failureMode = redactText(event.issue.failureMode).text;
  const subject = `[Exhibit/Lemma] ${verb}: ${title}`;
  const body = [`${verb}: ${title}`, '', `Failure mode: ${failureMode || '(none reported)'}`, `Trace: ${event.issue.traceUrl || '(no link)'}`, '', `Issue id: ${event.issue.id}`].join('\n');
  return { subject, body };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  opts: LemmaWebhookOptions,
  seenEvents: Map<string, number>,
  inFlightEvents: Set<string>,
): Promise<void> {
  if (req.method !== 'POST') {
    respondSafely(res, 404, 'text/plain', 'not found');
    return;
  }
  let body: string;
  try {
    body = await readBody(req);
  } catch (err) {
    if (err instanceof LemmaBodyTooLargeError) {
      respondSafely(res, 413, 'text/plain', 'payload too large');
      return;
    }
    // Client disconnected mid-body; nothing to respond to if the socket is already gone.
    respondSafely(res, 400, 'text/plain', 'bad request');
    return;
  }
  const signature = req.headers['x-lemma-signature'];
  const expected = lemmaSignature(body, opts.secret);
  if (typeof signature !== 'string' || !safeEqualHex(signature, expected)) {
    respondSafely(res, 401, 'text/plain', 'invalid signature');
    return;
  }
  const event = parseEvent(body);
  if (!event) {
    respondSafely(res, 400, 'text/plain', 'unrecognized event');
    return;
  }
  const now = Date.now();
  const key = replayKey(event, body);
  const alreadyDone = seenEvents.has(key);
  const alreadyInFlight = inFlightEvents.has(key);
  if (alreadyDone || alreadyInFlight) {
    // Already emailed (or a concurrent delivery of the same event is still in flight): no-op 200,
    // never a second email.
    respondSafely(res, 200, 'application/json', '{"ok":true}');
    return;
  }
  inFlightEvents.add(key);
  const { subject, body: emailBody } = emailFor(event);
  try {
    // The recipient always comes from opts.founderEmail, set at server construction time --
    // never from the payload -- so a malicious or malformed event can never redirect the send.
    await opts.sendEmail({ to: opts.founderEmail, subject, body: emailBody });
  } catch (err) {
    inFlightEvents.delete(key);
    // Do not ack: Lemma must see a failure so it retries and the founder's notification isn't lost.
    throw err;
  }
  inFlightEvents.delete(key);
  seenEvents.set(key, now);
  pruneDedupe(seenEvents, now);
  respondSafely(res, 200, 'application/json', '{"ok":true}');
}
