import { describe, expect, it } from 'vitest';
import type { CalendarEvent } from '../src/apps/types.js';
import { intake } from '../src/pipeline/intake.js';
import { Ledger } from '../src/ledger.js';
import { LocalTracer } from '../src/observability/tracer.js';
import { MemoryTwins } from '../src/twins/memory.js';
import { DARA, E, NOW, mail, seed } from '../harness/corpus.js';

// PRD 6.1: "Calendar: events that ended (not future events)". PRD 9 E6: a judge invite accepted
// then the event later cancelled stays `building`, with the cancellation noted -- which requires
// the cancelled event, once it has ended, to still reach intake. A cancelled event still in the
// future never occurred, so it must not be admitted.
// PRD 6.1 also says spam is never read: intake must skip Gmail messages labeled SPAM or TRASH.

async function runIntake(s: ReturnType<typeof seed>) {
  const twins = new MemoryTwins(s, { now: () => NOW });
  const ledger = new Ledger(':memory:');
  const tracer = new LocalTracer(null);
  const trace = (await tracer.run({ name: 'test', runId: 'r1', input: {} }, async (ctx) => ctx)).result;
  const result = await intake({ apps: twins.apps, profile: DARA, ledger, trace, now: NOW, extend: () => twins.extend() });
  ledger.close();
  return result;
}

function event(p: Partial<CalendarEvent> & { id: string; start: string; end: string; status: CalendarEvent['status'] }): CalendarEvent {
  return {
    summary: 'Test event',
    description: '',
    attendees: [],
    updated: p.start,
    ...p,
  };
}

describe('calendar intake admits only events that ended (PRD 6.1)', () => {
  it('admits a past, confirmed event that ended', async () => {
    const past = new Date(NOW.getTime() - 30 * 86_400_000);
    const s = seed({ gmail: [], calendar: [event({ id: 'ev-past-confirmed', start: past.toISOString(), end: new Date(past.getTime() + 3_600_000).toISOString(), status: 'confirmed' })] });
    const { items } = await runIntake(s);
    expect(items.some((i) => i.id === 'ev-past-confirmed')).toBe(true);
  });

  it('does NOT admit a future, confirmed event (has not ended)', async () => {
    const future = new Date(NOW.getTime() + 30 * 86_400_000);
    const s = seed({ gmail: [], calendar: [event({ id: 'ev-future-confirmed', start: future.toISOString(), end: new Date(future.getTime() + 3_600_000).toISOString(), status: 'confirmed' })] });
    const { items } = await runIntake(s);
    expect(items.some((i) => i.id === 'ev-future-confirmed')).toBe(false);
  });

  it('admits a past, cancelled event that already ended, so the cancellation can be noted (E6)', async () => {
    const past = new Date(NOW.getTime() - 10 * 86_400_000);
    const s = seed({ gmail: [], calendar: [event({ id: 'ev-past-cancelled', start: past.toISOString(), end: new Date(past.getTime() + 3_600_000).toISOString(), status: 'cancelled' })] });
    const { items } = await runIntake(s);
    expect(items.some((i) => i.id === 'ev-past-cancelled')).toBe(true);
  });

  it('does NOT admit a future, cancelled event (nothing occurred yet)', async () => {
    const future = new Date(NOW.getTime() + 10 * 86_400_000);
    const s = seed({ gmail: [], calendar: [event({ id: 'ev-future-cancelled', start: future.toISOString(), end: new Date(future.getTime() + 3_600_000).toISOString(), status: 'cancelled' })] });
    const { items } = await runIntake(s);
    expect(items.some((i) => i.id === 'ev-future-cancelled')).toBe(false);
  });
});

describe('spam is never read (PRD 6.1)', () => {
  it('skips a Gmail message labeled SPAM', async () => {
    const spamMsg = mail({ id: 'm-spam-1', from: 'promo@spammy.example', date: NOW.toISOString(), subject: 'You judged, you won!', body: 'Congratulations, click here.', labels: ['SPAM'] });
    const s = seed({ gmail: [spamMsg] });
    const { items } = await runIntake(s);
    expect(items.some((i) => i.id === 'm-spam-1')).toBe(false);
  });

  it('skips a Gmail message labeled TRASH', async () => {
    const trashedMsg = mail({ id: 'm-trash-1', from: 'someone@loomwork.example', date: NOW.toISOString(), subject: 'Old thing', body: 'body', labels: ['TRASH'] });
    const s = seed({ gmail: [trashedMsg] });
    const { items } = await runIntake(s);
    expect(items.some((i) => i.id === 'm-trash-1')).toBe(false);
  });

  it('still admits an ordinary INBOX message from the same seed', async () => {
    const ok = mail({ id: 'm-ok-1', from: 'organizer@buildnight.example', date: NOW.toISOString(), subject: 'Judge invite', body: 'Would you judge our event?', labels: ['INBOX'] });
    const spamMsg = mail({ id: 'm-spam-2', from: 'promo@spammy.example', date: NOW.toISOString(), subject: 'Spam', body: 'buy now', labels: ['SPAM'] });
    const s = seed({ gmail: [ok, spamMsg] });
    const { items } = await runIntake(s);
    expect(items.some((i) => i.id === 'm-ok-1')).toBe(true);
    expect(items.some((i) => i.id === 'm-spam-2')).toBe(false);
  });
});
