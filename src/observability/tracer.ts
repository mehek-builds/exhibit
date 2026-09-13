import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Lemma } from '@uselemma/tracing';
import { scrubForBoundary } from '../pipeline/redact.js';
import type { Redaction } from '../types.js';

// Every run is one trace named `exhibit` (PRD 6.10). The local recorder always runs, because the
// Arga grader and the local auditor read it; Lemma receives the same records when keys are set.
// A Lemma delivery failure never replaces or hides Exhibit's own result.
//
// PRD 6.10: text conversations (6.13) carry a threadId per conversation so Lemma sees a misread
// command in the context of the exchange, and issue extraction for threaded traces waits until the
// conversation goes quiet. Batch runs stay unthreaded so their issues appear immediately. PRD 12.6:
// every trace carries the scenario id and the git SHA (release) as metadata.

export interface TraceEvent {
  traceId: string;
  runId: string;
  seq: number;
  type: 'tool' | 'generation' | 'span' | 'boundary_leak';
  name: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  model?: string;
  leaked?: Redaction[];
  /** Set only for a conversation trace (PRD 6.10); absent on unthreaded batch-run events. */
  threadId?: string;
  metadata?: Record<string, string>;
}

export interface TraceContext {
  readonly traceId: string;
  readonly runId: string;
  readonly threadId?: string;
  tool(name: string, input: unknown, output?: unknown, error?: string): void;
  generation(name: string, model: string, input: unknown, output: unknown, error?: string): void;
  span(name: string, input?: unknown, output?: unknown, error?: string): void;
}

export interface TraceRunOptions {
  name: string;
  runId: string;
  input: unknown;
  /** Omit for batch runs (PRD 6.10: batch runs stay unthreaded). Set only for a text conversation. */
  threadId?: string;
  metadata?: Record<string, string>;
}

export interface TraceConversationOptions {
  /** Stable per conversation; use `conversationThreadId()` to derive it. */
  threadId: string;
  name: string;
  input: unknown;
  metadata?: Record<string, string>;
  /** The batch trace this conversation trace should be linked from, by id, in a span. */
  parentTrace?: TraceContext;
}

export interface Tracer {
  readonly kind: 'local' | 'lemma+local';
  run<T>(opts: TraceRunOptions, fn: (ctx: TraceContext) => Promise<T>): Promise<{ result: T; traceId: string }>;
  /** A nested, threaded trace (PRD 6.10) -- one per inbound text conversation, linked from the batch trace. */
  conversation<T>(opts: TraceConversationOptions, fn: (ctx: TraceContext) => Promise<T>): Promise<{ result: T; traceId: string }>;
  events(filter?: { traceId?: string; runId?: string; threadId?: string }): TraceEvent[];
  deliveryErrors: string[];
}

export class LocalTracer implements Tracer {
  readonly kind: Tracer['kind'] = 'local';
  deliveryErrors: string[] = [];
  protected all: TraceEvent[] = [];
  private seq = 0;

  constructor(private readonly dir: string | null = null) {
    if (dir) mkdirSync(dir, { recursive: true });
  }

  events(filter: { traceId?: string; runId?: string; threadId?: string } = {}): TraceEvent[] {
    return this.all.filter(
      (e) => (!filter.traceId || e.traceId === filter.traceId) && (!filter.runId || e.runId === filter.runId) && (!filter.threadId || e.threadId === filter.threadId),
    );
  }

  protected push(ev: Omit<TraceEvent, 'seq'>, forward?: (ev: TraceEvent) => void): void {
    const scrubbedIn = scrubForBoundary(ev.input);
    const scrubbedOut = scrubForBoundary(ev.output);
    const leaked = [...scrubbedIn.leaked, ...scrubbedOut.leaked];
    this.seq += 1;
    const safe: TraceEvent = { ...ev, seq: this.seq, input: scrubbedIn.value, output: scrubbedOut.value };
    this.all.push(safe);
    if (this.dir) appendFileSync(join(this.dir, `${ev.traceId}.jsonl`), `${JSON.stringify(safe)}\n`);
    forward?.(safe);
    if (leaked.length) {
      // The boundary scrub caught something upstream redaction missed. Recorded as a violation of
      // hard constraint 8, never silently absorbed.
      this.seq += 1;
      const leak: TraceEvent = { traceId: ev.traceId, runId: ev.runId, seq: this.seq, type: 'boundary_leak', name: ev.name, leaked, threadId: ev.threadId, metadata: ev.metadata };
      this.all.push(leak);
      if (this.dir) appendFileSync(join(this.dir, `${ev.traceId}.jsonl`), `${JSON.stringify(leak)}\n`);
    }
  }

  protected context(traceId: string, runId: string, opts: { threadId?: string; metadata?: Record<string, string> } = {}, forward?: (ev: TraceEvent) => void): TraceContext {
    const { threadId, metadata } = opts;
    return {
      traceId,
      runId,
      threadId,
      tool: (name, input, output, error) => this.push({ traceId, runId, threadId, metadata, type: 'tool', name, input, output, error }, forward),
      generation: (name, model, input, output, error) => this.push({ traceId, runId, threadId, metadata, type: 'generation', name, model, input, output, error }, forward),
      span: (name, input, output, error) => this.push({ traceId, runId, threadId, metadata, type: 'span', name, input, output, error }, forward),
    };
  }

  async run<T>(opts: TraceRunOptions, fn: (ctx: TraceContext) => Promise<T>): Promise<{ result: T; traceId: string }> {
    const traceId = `tr_${randomUUID()}`;
    const ctx = this.context(traceId, opts.runId, { threadId: opts.threadId, metadata: opts.metadata });
    ctx.span(`${opts.name}:start`, opts.input);
    const result = await fn(ctx);
    ctx.span(`${opts.name}:end`, undefined, summarize(result));
    return { result, traceId };
  }

  async conversation<T>(opts: TraceConversationOptions, fn: (ctx: TraceContext) => Promise<T>): Promise<{ result: T; traceId: string }> {
    const runId = opts.parentTrace?.runId ?? opts.threadId;
    // Dispatches through `this.run`, so LemmaTracer's override (which delivers a threaded Lemma
    // trace) applies automatically -- this method never needs its own override.
    const { result, traceId } = await this.run({ name: opts.name, runId, input: opts.input, threadId: opts.threadId, metadata: opts.metadata }, fn);
    opts.parentTrace?.span('conversation.link', { threadId: opts.threadId }, { traceId });
    return { result, traceId };
  }
}

export class LemmaTracer extends LocalTracer {
  override readonly kind: Tracer['kind'] = 'lemma+local';
  private readonly lemma: Lemma;

  constructor(opts: { apiKey: string; projectId: string; release?: string; dir?: string | null; client?: Lemma }) {
    super(opts.dir ?? null);
    this.lemma = opts.client ?? new Lemma({ apiKey: opts.apiKey, projectId: opts.projectId, release: opts.release });
  }

  override async run<T>(opts: TraceRunOptions, fn: (ctx: TraceContext) => Promise<T>): Promise<{ result: T; traceId: string }> {
    const traceId = `tr_${randomUUID()}`;
    let settled = false;
    let result: T | undefined;
    let failure: unknown;
    const safeInput = scrubForBoundary({ ...(opts.input as object), exhibit_trace_id: traceId }).value;
    try {
      await this.lemma.trace({ name: opts.name, input: safeInput as never, threadId: opts.threadId, metadata: opts.metadata }, async (lemmaTrace) => {
        const forward = (ev: TraceEvent) => {
          try {
            if (ev.type === 'tool') lemmaTrace.recordTool({ name: ev.name, input: ev.input as never, output: (ev.error ? { error: ev.error } : ev.output) as never });
            else if (ev.type === 'generation') lemmaTrace.recordGeneration({ name: ev.name, input: ev.input as never, output: ev.output as never, model: ev.model });
            else lemmaTrace.recordSpan({ name: ev.name, input: ev.input as never, output: (ev.error ? { error: ev.error } : ev.output) as never });
          } catch (err) {
            this.deliveryErrors.push(String(err));
          }
        };
        const ctx = this.context(traceId, opts.runId, { threadId: opts.threadId, metadata: opts.metadata }, forward);
        try {
          result = await fn(ctx);
        } catch (err) {
          failure = err;
        } finally {
          settled = true;
        }
        if (failure) throw failure;
        return summarize(result) as never;
      });
    } catch (err) {
      if (!settled) {
        // Lemma failed before the agent ran: run the agent with local tracing only.
        this.deliveryErrors.push(`lemma trace start failed: ${String(err)}`);
        return super.run(opts, fn);
      }
      if (failure) throw failure;
      this.deliveryErrors.push(`lemma delivery failed: ${String(err)}`);
    }
    return { result: result as T, traceId };
  }
}

function summarize(result: unknown): unknown {
  if (result && typeof result === 'object' && 'summary' in (result as Record<string, unknown>)) return (result as Record<string, unknown>).summary;
  return undefined;
}

/**
 * A stable per-conversation thread id (PRD 6.10, 6.13). A conversation is messages from the same
 * founder number with gaps under 30 minutes; the caller (the text channel) is responsible for
 * picking `startedAt` -- the first message's time when starting a new conversation, or the prior
 * conversation's `startedAt` when the gap since the last message is under 30 minutes. Never embeds
 * the raw phone number: it is hashed into the id.
 */
export function conversationThreadId(founderPhone: string, startedAt: Date): string {
  const digest = createHash('sha256').update(`${founderPhone}|${startedAt.toISOString()}`).digest('hex').slice(0, 24);
  return `conv_${digest}`;
}

export function createTracer(env: NodeJS.ProcessEnv, dir: string | null): Tracer {
  if (env.LEMMA_API_KEY && env.LEMMA_PROJECT_ID) {
    return new LemmaTracer({ apiKey: env.LEMMA_API_KEY, projectId: env.LEMMA_PROJECT_ID, release: env.LEMMA_RELEASE, dir });
  }
  return new LocalTracer(dir);
}
