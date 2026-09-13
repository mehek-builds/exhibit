import { describe, expect, it } from 'vitest';
import { LocalTracer, conversationThreadId } from '../src/observability/tracer.js';
import type { TraceContext } from '../src/observability/tracer.js';

// PRD 6.10: batch runs stay unthreaded; text conversations (6.13) carry a threadId per conversation
// so the audit reads a misread command in the context of the exchange.

describe('LocalTracer.run: batch traces', () => {
  it('has no threadId and carries release + scenario metadata', async () => {
    const tracer = new LocalTracer();
    const { traceId } = await tracer.run({ name: 'exhibit', runId: 'r1', input: {}, metadata: { release: 'sha123', scenario_id: 's20' } }, async (ctx) => {
      expect(ctx.threadId).toBeUndefined();
      ctx.tool('some.tool', { a: 1 }, { b: 2 });
      return { ok: true };
    });
    const events = tracer.events({ traceId });
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.threadId).toBeUndefined();
      expect(e.metadata).toEqual({ release: 'sha123', scenario_id: 's20' });
    }
  });
});

describe('LocalTracer.conversation: threaded conversation traces', () => {
  it('shares a threadId across messages within 30 minutes, and gets a new one after a gap', async () => {
    const tracer = new LocalTracer();
    const phone = '+15550100142';
    const t0 = new Date('2026-09-13T10:00:00Z');
    const t1 = new Date('2026-09-13T10:10:00Z'); // 10 min later, same conversation
    const t2 = new Date('2026-09-13T11:00:00Z'); // 50 min after t1, new conversation

    const thread1 = conversationThreadId(phone, t0);
    const thread2 = conversationThreadId(phone, t0); // same startedAt -> same conversation
    const thread3 = conversationThreadId(phone, t2); // new startedAt after the gap

    expect(thread1).toBe(thread2);
    expect(thread1).not.toBe(thread3);

    const { traceId: trace1 } = await tracer.conversation({ threadId: thread1, name: 'exhibit-text', input: { at: t0.toISOString() } }, async (ctx) => {
      expect(ctx.threadId).toBe(thread1);
      ctx.span('msg', { body: 'approve 1' });
    });
    const { traceId: trace2 } = await tracer.conversation({ threadId: thread1, name: 'exhibit-text', input: { at: t1.toISOString() } }, async (ctx) => {
      expect(ctx.threadId).toBe(thread1);
      ctx.span('msg', { body: 'yes' });
    });
    const { traceId: trace3 } = await tracer.conversation({ threadId: thread3, name: 'exhibit-text', input: { at: t2.toISOString() } }, async (ctx) => {
      expect(ctx.threadId).toBe(thread3);
      ctx.span('msg', { body: 'status' });
    });

    expect(trace1).not.toBe(trace2); // each message is its own trace
    expect(tracer.events({ threadId: thread1 }).every((e) => e.threadId === thread1)).toBe(true);
    expect(tracer.events({ threadId: thread1 }).length).toBeGreaterThan(0);
    expect(tracer.events({ threadId: thread3 }).some((e) => e.traceId === trace3)).toBe(true);
    expect(new Set(tracer.events({ threadId: thread1 }).map((e) => e.traceId)).size).toBe(2); // trace1 and trace2
  });

  it('links the conversation trace from the batch trace by id, in a span', async () => {
    const tracer = new LocalTracer();
    const { result: batchCtx, traceId: batchTraceId } = await tracer.run({ name: 'exhibit', runId: 'r1', input: {} }, async (ctx) => ctx);
    const thread = conversationThreadId('+15550100142', new Date('2026-09-13T10:00:00Z'));
    const { traceId: convTraceId } = await tracer.conversation({ threadId: thread, name: 'exhibit-text', input: {}, parentTrace: batchCtx as TraceContext }, async () => undefined);

    const linkSpan = tracer.events({ traceId: batchTraceId }).find((e) => e.name === 'conversation.link');
    expect(linkSpan).toBeDefined();
    expect((linkSpan!.output as { traceId: string }).traceId).toBe(convTraceId);
    expect((linkSpan!.input as { threadId: string }).threadId).toBe(thread);
  });
});

describe('conversationThreadId: never contains the raw phone number', () => {
  it('the phone number never appears in the thread id, across many phones and times', () => {
    const phones = ['+15550100142', '+442071838750', '+15005550006'];
    for (const phone of phones) {
      const thread = conversationThreadId(phone, new Date('2026-09-13T10:00:00Z'));
      expect(thread).not.toContain(phone);
      expect(thread).not.toContain(phone.replace('+', ''));
      // digits-only substring check too, in case of formatting differences
      const digits = phone.replace(/\D/g, '');
      expect(thread).not.toContain(digits);
    }
  });

  it('the thread id is stable per (phone, startedAt) pair and differs across phones', () => {
    const at = new Date('2026-09-13T10:00:00Z');
    const a1 = conversationThreadId('+15550100142', at);
    const a2 = conversationThreadId('+15550100142', at);
    const b = conversationThreadId('+15550100199', at);
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });
});

describe('LocalTracer: boundary scrub still applies', () => {
  it('a leaked redaction is recorded as a boundary_leak event even with threadId/metadata set', async () => {
    const tracer = new LocalTracer();
    const thread = conversationThreadId('+15550100142', new Date());
    await tracer.conversation({ threadId: thread, name: 'exhibit-text', input: {} }, async (ctx) => {
      // A raw passport number slipping through upstream redaction should still be caught.
      ctx.tool('classify', {}, { note: 'passport 123456789' });
    });
    const leak = tracer.events({ threadId: thread }).find((e) => e.type === 'boundary_leak');
    expect(leak).toBeDefined();
  });
});
