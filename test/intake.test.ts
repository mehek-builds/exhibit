import { describe, expect, it } from 'vitest';
import { gmailItem, intake, parseLooseDate, unwrapForward } from '../src/pipeline/intake.js';
import { Ledger } from '../src/ledger.js';
import { LocalTracer } from '../src/observability/tracer.js';
import { MemoryTwins } from '../src/twins/memory.js';
import { DARA, E, fullYearSeed, NOW, seed } from '../harness/corpus.js';

// PRD 6.1: intake unwraps forwards, dedupes by source id, keeps the founder's own sent mail as
// context (not a candidate), and degrades gracefully when a source is unavailable.

describe('unwrapForward', () => {
  it('preserves the ORIGINAL date and sender of a forwarded message, not the forwarder\'s (E2)', () => {
    const msg = E.forwarded[0]!; // "Fwd: The Build Report interview..." forwarded by ren@loomwork.example
    const un = unwrapForward(msg);
    expect(un.forwarded).toBe(true);
    expect(un.from).toContain('editors@buildreport.example');
    expect(un.date).not.toBeNull();
    expect(new Date(un.date!).toISOString().slice(0, 10)).toBe('2026-05-19');
    // The forwarder's own send date (2026-06-02) must NOT be treated as the exhibit date.
    expect(new Date(un.date!).toISOString().slice(0, 10)).not.toBe('2026-06-02');
  });

  it('returns forwarded: false and the original fields for a non-forwarded message', () => {
    const msg = E.press[0]!;
    const un = unwrapForward(msg);
    expect(un.forwarded).toBe(false);
    expect(un.from).toBe(msg.from);
    expect(un.subject).toBe(msg.subject);
  });

  it('gmailItem uses the unwrapped date as the exhibit date and keeps the forwarder as forwardedBy metadata', () => {
    const msg = E.forwarded[0]!;
    const out = gmailItem(msg);
    expect(out.date).not.toBeNull();
    expect(new Date(out.date!).toISOString().slice(0, 10)).toBe('2026-05-19');
    expect(out.meta.forwarded).toBe(true);
    expect(String(out.meta.forwardedBy)).toContain('ren@loomwork.example');
    // receivedAt carries the forwarder's send time, never used as the exhibit date.
    expect(out.receivedAt).not.toBe(out.date);
  });
});

describe('parseLooseDate', () => {
  it('parses an RFC-2822-ish date string (as produced by mail())', () => {
    const d = parseLooseDate('Wed, 18 Mar 2026 14:00:00 GMT');
    expect(d).not.toBeNull();
    expect(new Date(d!).toISOString().slice(0, 10)).toBe('2026-03-18');
  });

  it('parses a date with a trailing timezone parenthetical, stripping it', () => {
    const d = parseLooseDate('Tue, 19 May 2026 09:14:00 -0700 (PDT)');
    expect(d).not.toBeNull();
  });

  it('returns null for garbage input', () => {
    expect(parseLooseDate('not a date at all')).toBeNull();
    expect(parseLooseDate(undefined)).toBeNull();
    expect(parseLooseDate(null)).toBeNull();
  });

  it('handles the "at" separator some calendar-style strings use', () => {
    const d = parseLooseDate('March 18, 2026 at 2:00 PM');
    expect(d).not.toBeNull();
  });
});

describe('mail the founder SENT is treated as context, not a candidate exhibit', () => {
  it('a sent reply never appears in items[], but does appear in context.founderMessages', async () => {
    const s = seed({ gmail: [...E.accelerator] }); // includes m-accel (received) and m-accel-reply (sent)
    const twins = new MemoryTwins(s, { now: () => NOW });
    const ledger = new Ledger(':memory:');
    const tracer = new LocalTracer(null);
    const trace = (await tracer.run({ name: 'test', runId: 'r1', input: {} }, async (ctx) => ctx)).result;
    const { items, context } = await intake({ apps: twins.apps, profile: DARA, ledger, trace, now: NOW, extend: () => twins.extend() });

    expect(items.some((i) => i.id === 'm-accel-reply')).toBe(false);
    expect(context.founderMessages.some((m) => m.id === 'm-accel-reply')).toBe(true);
    expect(items.some((i) => i.id === 'm-accel')).toBe(true);
    ledger.close();
  });
});

describe('LinkedIn-unavailable degrades gracefully rather than crashing', () => {
  it('intake completes and records "linkedin" in context.degraded when the LinkedIn twin is unavailable', async () => {
    const s = fullYearSeed();
    const twins = new MemoryTwins(s, { now: () => NOW, linkedinUnavailable: true });
    const ledger = new Ledger(':memory:');
    const tracer = new LocalTracer(null);
    const trace = (await tracer.run({ name: 'test', runId: 'r1', input: {} }, async (ctx) => ctx)).result;
    const { context } = await intake({ apps: twins.apps, profile: DARA, ledger, trace, now: NOW, extend: () => twins.extend() });
    expect(context.degraded).toContain('linkedin');
    expect(context.followers).toBeNull();
    ledger.close();
  });

  it('intake also degrades cleanly when the seed has linkedin: null (no twin surface at all)', async () => {
    const s = seed({ gmail: [...E.accelerator], linkedin: null });
    const twins = new MemoryTwins(s, { now: () => NOW });
    const ledger = new Ledger(':memory:');
    const tracer = new LocalTracer(null);
    const trace = (await tracer.run({ name: 'test', runId: 'r1', input: {} }, async (ctx) => ctx)).result;
    const { context } = await intake({ apps: twins.apps, profile: DARA, ledger, trace, now: NOW, extend: () => twins.extend() });
    expect(context.degraded).toContain('linkedin');
    ledger.close();
  });
});

describe('re-running intake on already-processed items is idempotent (skips them)', () => {
  it('a second intake run over the same seed returns no items once they are all marked done', async () => {
    const s = seed({ gmail: [...E.accelerator] });
    const twins = new MemoryTwins(s, { now: () => NOW });
    const ledger = new Ledger(':memory:');
    const tracer = new LocalTracer(null);
    const trace = (await tracer.run({ name: 'test', runId: 'r1', input: {} }, async (ctx) => ctx)).result;

    const first = await intake({ apps: twins.apps, profile: DARA, ledger, trace, now: NOW, extend: () => twins.extend() });
    expect(first.items.length).toBeGreaterThan(0);
    // Mark every item this run saw as fully processed, as the pipeline would after mapping/filing.
    for (const it of first.items) ledger.markItem(it.app, it.id, 'r1', 'done');

    const second = await intake({ apps: twins.apps, profile: DARA, ledger, trace, now: NOW, extend: () => twins.extend() });
    const secondIds = new Set(second.items.map((i) => `${i.app}:${i.id}`));
    for (const it of first.items) expect(secondIds.has(`${it.app}:${it.id}`)).toBe(false);
    ledger.close();
  });
});
