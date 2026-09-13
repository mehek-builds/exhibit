import { describe, expect, it } from 'vitest';
import type { TextMessage, TwilioApi } from '../src/apps/types.js';
import { createHarnessEnv } from '../harness/env.js';
import { fullYearSeed } from '../harness/corpus.js';
import { runScenarioAttempt } from '../harness/runner.js';
import { S26 } from '../harness/scenarios/s26-proactive.js';
import { createNotifier } from '../src/notify/notifier.js';
import { inQuietHours, nextAllowed } from '../src/notify/quietHours.js';
import { listFiguresText } from '../src/text/channel.js';

// Notifier tests (PRD 4.1, 6.8, 6.13): quiet hours, the first-scorecard text's numbers, digest
// idempotency, quiet-hours deferral, a worth-sending hold, texts_stopped, and the no-twilio fallback.

class FakeTwilioApi implements TwilioApi {
  readonly sender: string;
  sent: { to: string; body: string }[] = [];
  private inbound: TextMessage[] = [];
  constructor(sender = 'whatsapp:+14155238886') {
    this.sender = sender;
  }
  async send(message: { to: string; body: string }) {
    this.sent.push(message);
    return { sid: `SM_fake_${this.sent.length}` };
  }
  async listInbound() {
    return this.inbound;
  }
  /** Test helper: record a founder inbound message at a given time, as MemoryTwilio.adminInbound would. */
  pushInbound(from: string, dateSent: string): void {
    this.inbound.push({ sid: `SMin_fake_${this.inbound.length + 1}`, from, to: this.sender, body: 'hi', direction: 'inbound', channel: this.sender.startsWith('whatsapp:') ? 'whatsapp' : 'sms', dateSent });
  }
}

function withNotifier(seed = fullYearSeed(), opts: Parameters<typeof createNotifier>[0] = {}) {
  const env = createHarnessEnv({ seed, gate: 'library' });
  const twilio = new FakeTwilioApi();
  env.deps.apps = { ...env.deps.apps, twilio };
  env.deps.extensions = [createNotifier(opts)];
  return { env, twilio };
}

describe('quiet hours', () => {
  const q = { start: '22:00', end: '08:00', timeZone: 'America/Los_Angeles' };

  it('is quiet just after 22:00 local and not quiet just after 08:00 local, across midnight', () => {
    // 2026-01-15 06:30 UTC is 2026-01-14 22:30 PST (UTC-8, no DST in January).
    expect(inQuietHours(new Date('2026-01-15T06:30:00Z'), q)).toBe(true);
    // 2026-01-15 16:30 UTC is 2026-01-15 08:30 PST.
    expect(inQuietHours(new Date('2026-01-15T16:30:00Z'), q)).toBe(false);
  });

  it('handles the DST transition (PDT is UTC-7 in summer)', () => {
    // 2026-07-15 05:30 UTC is 2026-07-14 22:30 PDT.
    expect(inQuietHours(new Date('2026-07-15T05:30:00Z'), q)).toBe(true);
    // 2026-07-15 15:30 UTC is 2026-07-15 08:30 PDT.
    expect(inQuietHours(new Date('2026-07-15T15:30:00Z'), q)).toBe(false);
  });

  it('nextAllowed returns an instant outside the quiet window', () => {
    const now = new Date('2026-01-15T06:30:00Z'); // quiet
    const allowed = nextAllowed(now, q);
    expect(inQuietHours(allowed, q)).toBe(false);
    expect(allowed.getTime()).toBeGreaterThanOrEqual(now.getTime());
  });
});

describe('first-scorecard text', () => {
  it('uses the real numbers from this run\'s scorecard, sent by text', async () => {
    const { env, twilio } = withNotifier();
    env.clock.set(new Date('2026-09-13T16:00:00Z')); // 09:00 PDT, outside quiet hours
    twilio.pushInbound(env.profile.phone!, env.clock.now().toISOString()); // WhatsApp window open (finding 2)
    const summary = await env.run();
    expect(env.ledger.get('first_scorecard_sent')).toBe('1');
    expect(twilio.sent.length).toBeGreaterThan(0);
    const body = twilio.sent.map((m) => m.body).join('\n');
    const sc = summary.scorecard!;
    expect(body).toContain(`O-1A: ${sc.o1Met} of 8 criteria`);
    expect(body).toContain(`EB-1A: ${sc.eb1Met} of 10`);
    expect(body).toContain(sc.nextAction);
    expect(body).toContain(String(sc.figures.pending));
  });
});

describe('digest', () => {
  it('is not sent twice inside 6 days', async () => {
    const { env, twilio } = withNotifier();
    // First run: land on a Sunday at 10am Pacific.
    env.clock.set(new Date('2026-09-13T17:00:00Z')); // Sunday 10:00 PDT
    twilio.pushInbound(env.profile.phone!, env.clock.now().toISOString()); // WhatsApp window open (finding 2)
    await env.run();
    const digestsAfterFirst = twilio.sent.filter((m) => /Next action:/.test(m.body)).length;
    expect(digestsAfterFirst).toBeGreaterThan(0);
    const firstCount = twilio.sent.length;

    // Second run, next Sunday's morning minus a day: still inside 6 days, must not resend.
    env.clock.advance(2 * 24 * 60 * 60 * 1000);
    twilio.pushInbound(env.profile.phone!, env.clock.now().toISOString()); // window still open on this run
    await env.run();
    expect(twilio.sent.length).toBe(firstCount);
  });
});

describe('quiet-hours deferral', () => {
  it('defers a would-be send during quiet hours and sends it once the window opens', async () => {
    const { env, twilio } = withNotifier();
    env.clock.set(new Date('2026-01-15T06:30:00Z')); // quiet (22:30 PST)
    await env.run();
    expect(twilio.sent.length).toBe(0);
    expect(env.ledger.get('first_scorecard_sent')).toBeNull();
    const deferred = env.ledger.events({ kind: 'notification' }).some((e) => e.detail.quiet_hours === true && e.detail.sent === false);
    expect(deferred).toBe(true);

    env.clock.set(new Date('2026-01-15T16:30:00Z')); // 08:30 PST, outside quiet hours
    twilio.pushInbound(env.profile.phone!, env.clock.now().toISOString()); // WhatsApp window open (finding 2)
    await env.run();
    expect(twilio.sent.length).toBeGreaterThan(0);
    expect(env.ledger.get('first_scorecard_sent')).toBe('1');
  });
});

describe('worth-sending hold', () => {
  it('prevents any send when the gate is unavailable', async () => {
    const env = createHarnessEnv({ seed: fullYearSeed(), gate: 'unavailable' });
    const twilio = new FakeTwilioApi();
    env.deps.apps = { ...env.deps.apps, twilio };
    env.deps.extensions = [createNotifier()];
    env.clock.set(new Date('2026-09-13T16:00:00Z')); // outside quiet hours
    await env.run();
    expect(twilio.sent.length).toBe(0);
    const holds = env.ledger.events({ kind: 'notification' }).filter((e) => e.detail.decision === 'hold');
    expect(holds.length).toBeGreaterThan(0);
    for (const h of holds) expect(h.detail.sent).toBe(false);
  });
});

describe('texts_stopped', () => {
  it('sends nothing once texts_stopped is set', async () => {
    const { env, twilio } = withNotifier();
    env.ledger.set('texts_stopped', '1');
    await env.run();
    expect(twilio.sent.length).toBe(0);
    const events = env.ledger.events({ kind: 'notification' });
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e.detail.sent).toBe(false);
  });
});

describe('no twilio configured', () => {
  it('falls back to one email to the founder for the first-scorecard message only', async () => {
    const env = createHarnessEnv({ seed: fullYearSeed(), gate: 'library' });
    env.deps.extensions = [createNotifier()];
    env.clock.set(new Date('2026-09-13T16:00:00Z')); // outside quiet hours
    await env.run();
    const notifications = env.ledger.events({ kind: 'notification' });
    const emailSent = notifications.filter((e) => e.detail.channel === 'email' && e.detail.sent === true);
    expect(emailSent.length).toBe(1);
    expect(emailSent[0]!.detail.kind).toBe('first_scorecard');
    const smsSent = notifications.filter((e) => e.detail.sent === true && e.detail.channel !== 'email');
    expect(smsSent.length).toBe(0);
  });
});

// Finding 1: the notifier must reuse listFiguresText -- the same function the text channel uses to
// resolve "approve <n>" -- so the numbers on the founder's phone always match what a reply resolves.
describe('figure numbering matches the text channel (finding 1)', () => {
  it("the first-scorecard text's figure list is exactly listFiguresText's output, and it writes the same kv the text channel reads", async () => {
    const { env, twilio } = withNotifier();
    env.clock.set(new Date('2026-09-13T16:00:00Z')); // outside quiet hours
    twilio.pushInbound(env.profile.phone!, env.clock.now().toISOString()); // WhatsApp window open (finding 2)
    await env.run();
    const pending = env.ledger.figures({ status: 'pending' });
    expect(pending.length).toBeGreaterThan(0);
    // listFiguresText is idempotent and writes text_figure_numbers as a side effect; calling it again
    // here must reproduce exactly what the notifier already sent and already wrote.
    const expectedText = listFiguresText(pending, env.ledger);
    const body = twilio.sent.map((m) => m.body).join('\n');
    expect(body).toContain(expectedText);
    const numberMap = JSON.parse(env.ledger.get('text_figure_numbers')!) as Record<string, string>;
    expect(numberMap['1']).toBe(pending[0]!.fig_id);
  });
});

// Finding 2: the WhatsApp Sandbox only accepts free-form proactive messages within 24 hours of the
// founder's last inbound message.
describe('WhatsApp 24-hour window (finding 2)', () => {
  it('sends a proactive digest when the founder texted inside the last 24 hours', async () => {
    const { env, twilio } = withNotifier();
    env.clock.set(new Date('2026-09-13T17:00:00Z')); // Sunday 10:00 PDT, outside quiet hours
    twilio.pushInbound(env.profile.phone!, new Date('2026-09-13T16:30:00Z').toISOString()); // 30 min earlier
    await env.run();
    expect(twilio.sent.length).toBeGreaterThan(0);
  });

  it('defers (never drops) a proactive send once the founder has gone quiet for more than 24 hours, and never resends a kind already delivered', async () => {
    const { env, twilio } = withNotifier();
    env.clock.set(new Date('2026-09-13T17:00:00Z')); // Sunday 10:00 PDT: everything sends once, window open
    twilio.pushInbound(env.profile.phone!, new Date('2026-09-13T09:00:00Z').toISOString());
    await env.run();
    const sentAfterFirst = twilio.sent.length;
    expect(sentAfterFirst).toBeGreaterThan(0);
    expect(env.ledger.get('first_scorecard_sent')).toBe('1');

    // Advance 7 days (back to Sunday, past the 6-day minimum gap) with no further inbound: the
    // window closes just as the next digest becomes due.
    env.clock.advance(7 * 24 * 60 * 60 * 1000);
    await env.run();
    expect(twilio.sent.length).toBe(sentAfterFirst); // nothing new actually sent
    const windowClosed = env.ledger.events({ kind: 'notification' }).filter((e) => e.detail.window_closed === true);
    expect(windowClosed.length).toBeGreaterThan(0);
    for (const e of windowClosed) {
      expect(e.detail.sent).toBe(false);
      expect((e.detail.reasons as string[]).includes('window_closed')).toBe(true);
    }

    // A fresh message reopens the window, and only the still-undelivered kind (the digest) goes out --
    // no duplicate of the already-sent first-scorecard text.
    twilio.pushInbound(env.profile.phone!, env.clock.now().toISOString());
    await env.run();
    expect(twilio.sent.length).toBeGreaterThan(sentAfterFirst);
    const firstScorecardSends = env.ledger.events({ kind: 'notification' }).filter((e) => e.detail.kind === 'first_scorecard' && e.detail.sent === true);
    expect(firstScorecardSends.length).toBe(1);
  });
});

describe('S26: proactive texts scenario', () => {
  it('passes every check', async () => {
    const result = await runScenarioAttempt(S26, 1, { gate: 'library' });
    const failed = result.checks.filter((c) => !c.pass);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    expect(result.sideEffects).toEqual([]);
  });
});
