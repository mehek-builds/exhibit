import { createHmac, timingSafeEqual } from 'node:crypto';
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

export function startLemmaWebhookServer(opts: LemmaWebhookOptions): LemmaWebhookServer {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res, opts);
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

async function handle(req: IncomingMessage, res: ServerResponse, opts: LemmaWebhookOptions): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(404).end();
    return;
  }
  let body: string;
  try {
    body = await readBody(req);
  } catch (err) {
    if (!(err instanceof LemmaBodyTooLargeError)) throw err;
    res.writeHead(413, { 'content-type': 'text/plain' }).end('payload too large');
    return;
  }
  const signature = req.headers['x-lemma-signature'];
  const expected = lemmaSignature(body, opts.secret);
  if (typeof signature !== 'string' || !safeEqualHex(signature, expected)) {
    res.writeHead(401, { 'content-type': 'text/plain' }).end('invalid signature');
    return;
  }
  const event = parseEvent(body);
  if (!event) {
    res.writeHead(400, { 'content-type': 'text/plain' }).end('unrecognized event');
    return;
  }
  const { subject, body: emailBody } = emailFor(event);
  try {
    // The recipient always comes from opts.founderEmail, set at server construction time --
    // never from the payload -- so a malicious or malformed event can never redirect the send.
    await opts.sendEmail({ to: opts.founderEmail, subject, body: emailBody });
  } catch {
    // A Lemma delivery failure never replaces or hides Exhibit's own result (6.10); just don't 500.
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
}
