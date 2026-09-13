import { describe, expect, it } from 'vitest';
import { createNotifier } from '../src/notify/notifier.js';
import { MemoryTwilio } from '../src/twins/twilio.js';
import { DARA, fullYearSeed, mail, NOW, seed } from '../harness/corpus.js';
import { createHarnessEnv } from '../harness/env.js';

function withSms() {
  return (env: ReturnType<typeof createHarnessEnv>) =>
    new MemoryTwilio({ sender: '+15550001111', now: env.clock.now, record: env.twins.recordOp.bind(env.twins) });
}

// PRD 4.1 / 6.13: "an immediate text only for time-sensitive items, such as a judge invite with a
// reply deadline". Before this fix, the nudge used `event_date`, which for an unanswered invite
// resolves to the invite EMAIL's own send date (src/pipeline/verifier.ts), never the reply deadline
// or judging date written in the invite text -- so a real invite received in the past never
// nudged. src/pipeline/inviteDate.ts now parses that date out of the invite text itself, and
// src/notify/notifier.ts prefers it over `event_date` for the C4-invite-unanswered nudge.

function nudgeNotifications(env: ReturnType<typeof createHarnessEnv>) {
  return env.deps.ledger.events({ kind: 'notification' }).filter((e) => e.detail.kind === 'nudge');
}

// 09:00 America/Los_Angeles in September (PDT, UTC-7) -- outside the default 22:00-08:00 quiet window.
function atLocalMorning(iso: string): Date {
  return new Date(iso);
}

describe('unanswered judge invite nudge uses the invite text date, not the email send date', () => {
  it('a past-dated invite whose reply deadline is 3 days away nudges exactly once', async () => {
    const invite = mail({
      id: 'm-nudge-deadline',
      from: 'Judge Wranglers <judges@wranglehacks.example>',
      date: '2026-08-01T12:00:00Z', // sent well in the past
      subject: 'Invitation to judge WrangleHacks',
      body: "Hi Dara,\n\nWe'd love you to judge WrangleHacks on September 30, 2026. Please reply by September 17.\n\nWrangleHacks",
    });
    const env = createHarnessEnv({
      seed: seed({ gmail: [invite] }),
      now: atLocalMorning('2026-09-14T00:00:00Z'), // Sept 17 deadline is exactly 3 days away
      gate: 'library',
      twilio: withSms(),
      extensions: () => [createNotifier()],
    });
    try {
      await env.run();
      const nudges = nudgeNotifications(env);
      expect(nudges.length).toBe(1);
      expect(nudges[0]!.detail.sent).toBe(true);

      const textOut = env.deps.ledger.events({ kind: 'text_out' }).find((e) => e.detail.kind === 'nudge');
      expect(String(textOut?.detail.body)).toContain('reply deadline');
      expect(String(textOut?.detail.body)).toContain('3 day');
      // Never leak identity numbers (FIG-/EX- ids) in a nudge.
      expect(String(textOut?.detail.body)).not.toMatch(/\b(FIG|EX)-\w+/);

      // Re-running the same clock does not resend (one-nudge-per-invite dedupe).
      await env.run();
      expect(nudgeNotifications(env).filter((e) => e.detail.sent === true).length).toBe(1);
    } finally {
      await env.close();
    }
  });

  it('an event date 5 days away with no reply deadline nudges, labeled as the event date', async () => {
    const invite = mail({
      id: 'm-nudge-event',
      from: 'BuildFest <judges@buildfest.example>',
      date: '2026-09-01T12:00:00Z',
      subject: 'Invitation to judge BuildFest',
      body: 'Hi Dara,\n\nWe would love you to judge BuildFest on September 19, 2026.\n\nBuildFest',
    });
    const env = createHarnessEnv({
      seed: seed({ gmail: [invite] }),
      now: atLocalMorning('2026-09-14T00:00:00Z'),
      gate: 'library',
      twilio: withSms(),
      extensions: () => [createNotifier()],
    });
    try {
      await env.run();
      const nudges = nudgeNotifications(env);
      expect(nudges.length).toBe(1);
      const textOut = env.deps.ledger.events({ kind: 'text_out' }).find((e) => e.detail.kind === 'nudge');
      expect(String(textOut?.detail.body)).toContain('event date');
      expect(String(textOut?.detail.body)).toContain('5 day');
    } finally {
      await env.close();
    }
  });

  it('a date 10 days out does not nudge, and neither does one already passed', async () => {
    const farInvite = mail({
      id: 'm-nudge-far',
      from: 'FarHacks <judges@farhacks.example>',
      date: '2026-09-01T12:00:00Z',
      subject: 'Invitation to judge FarHacks',
      body: 'Hi Dara,\n\nPlease reply by September 24 to confirm judging FarHacks.\n\nFarHacks',
    });
    const pastInvite = mail({
      id: 'm-nudge-past',
      from: 'PastHacks <judges@pasthacks.example>',
      date: '2026-08-01T12:00:00Z',
      subject: 'Invitation to judge PastHacks',
      body: 'Hi Dara,\n\nPlease reply by September 1 to confirm judging PastHacks.\n\nPastHacks',
    });
    const env = createHarnessEnv({
      seed: seed({ gmail: [farInvite, pastInvite] }),
      now: atLocalMorning('2026-09-14T00:00:00Z'), // Sept 24 is 10 days out; Sept 1 already passed
      gate: 'library',
      twilio: withSms(),
      extensions: () => [createNotifier()],
    });
    try {
      await env.run();
      expect(nudgeNotifications(env).length).toBe(0);
    } finally {
      await env.close();
    }
  });

  it('an answered invite never nudges', async () => {
    const invite = mail({
      id: 'm-nudge-answered',
      from: 'AnsweredHacks <judges@answeredhacks.example>',
      date: '2026-08-01T12:00:00Z',
      subject: 'Invitation to judge AnsweredHacks',
      body: 'Hi Dara,\n\nPlease reply by September 17 to confirm judging AnsweredHacks.\n\nAnsweredHacks',
    });
    const reply = mail({
      id: 'm-nudge-answered-reply',
      threadId: 'm-nudge-answered',
      from: `Dara Voss <${DARA.emails[0]}>`,
      to: ['judges@answeredhacks.example'],
      date: '2026-08-02T09:00:00Z',
      subject: 'Re: Invitation to judge AnsweredHacks',
      body: 'Happy to judge, count me in!',
      labels: ['SENT'],
    });
    const env = createHarnessEnv({
      seed: seed({ gmail: [invite, reply] }),
      now: atLocalMorning('2026-09-14T00:00:00Z'), // deadline would be 3 days away if still unanswered
      gate: 'library',
      twilio: withSms(),
      extensions: () => [createNotifier()],
    });
    try {
      await env.run();
      expect(nudgeNotifications(env).length).toBe(0);
      const c = env.deps.ledger.candidates().find((x) => x.title.includes('AnsweredHacks'));
      expect(c?.mapping.rule_id).not.toBe('C4-invite-unanswered');
    } finally {
      await env.close();
    }
  });

  it('a missing year rolls forward to the next occurrence after the invite\'s own date', async () => {
    // Sent Dec 20, 2026; "January 5" with no year must resolve to 2027-01-05, not 2026-01-05
    // (which would already be long past and could never nudge).
    const invite = mail({
      id: 'm-nudge-rollover',
      from: 'NewYearHacks <judges@newyearhacks.example>',
      date: '2026-12-20T12:00:00Z',
      subject: 'Invitation to judge NewYearHacks',
      body: 'Hi Dara,\n\nPlease reply by January 5 to confirm judging NewYearHacks.\n\nNewYearHacks',
    });
    const env = createHarnessEnv({
      seed: seed({ gmail: [invite] }),
      now: atLocalMorning('2027-01-02T00:00:00Z'), // 3 days before the rolled-forward 2027-01-05 deadline
      gate: 'library',
      twilio: withSms(),
      extensions: () => [createNotifier()],
    });
    try {
      await env.run();
      const nudges = nudgeNotifications(env);
      expect(nudges.length).toBe(1);
      const textOut = env.deps.ledger.events({ kind: 'text_out' }).find((e) => e.detail.kind === 'nudge');
      expect(String(textOut?.detail.body)).toContain('3 day');
    } finally {
      await env.close();
    }
  });

  it('the full synthetic year produces no unexpected nudges: the one unanswered invite (CodeCraft) has already passed by the harness clock', async () => {
    const env = createHarnessEnv({ seed: fullYearSeed(), now: NOW, gate: 'library', twilio: withSms(), extensions: () => [createNotifier()] });
    try {
      await env.run();
      // CodeCraft's invite text ("on August 30, 2026") is before NOW (2026-09-13); genuinely past,
      // so it must not nudge. No other invite in the year is unanswered at the harness clock.
      expect(nudgeNotifications(env).length).toBe(0);
    } finally {
      await env.close();
    }
  });

  // Regression tests for review findings B1-B4 (nudge-review.md) and the legacy-backfill gap.

  it('B1: a past day-first event date does not produce a false nudge', async () => {
    // "on 1 September 2026" must parse as Sept 1, not Sept 20 (misreading the year's digits as
    // the day). Sept 1 is 13 days before the harness clock, so it must never nudge.
    const invite = mail({
      id: 'm-nudge-b1',
      from: 'HackX <judges@hackxb1.example>',
      date: '2026-08-01T12:00:00Z',
      subject: 'Invitation to judge HackX',
      body: "Hi Dara,\n\nWe'd love you to judge HackX on 1 September 2026.\n\nHackX",
    });
    const env = createHarnessEnv({
      seed: seed({ gmail: [invite] }),
      now: atLocalMorning('2026-09-14T16:00:00Z'),
      gate: 'library',
      twilio: withSms(),
      extensions: () => [createNotifier()],
    });
    try {
      await env.run();
      expect(nudgeNotifications(env).length).toBe(0);
    } finally {
      await env.close();
    }
  });

  it('B2: a submission deadline is not read as a reply deadline; the real event date is used instead', async () => {
    const invite = mail({
      id: 'm-nudge-b2',
      from: 'HackX <judges@hackxb2.example>',
      date: '2026-09-01T12:00:00Z',
      subject: 'Invitation to judge HackX',
      body: "Hi Dara,\n\nWe'd love you to judge HackX on October 20, 2026. Project submission deadline: September 16.\n\nHackX",
    });
    const env = createHarnessEnv({
      seed: seed({ gmail: [invite] }),
      now: atLocalMorning('2026-09-14T16:00:00Z'), // 2 days before the fake "deadline"; 36 before the real event
      gate: 'library',
      twilio: withSms(),
      extensions: () => [createNotifier()],
    });
    try {
      await env.run();
      // No false "reply deadline" nudge from the submission deadline.
      expect(nudgeNotifications(env).length).toBe(0);
      const c = env.deps.ledger.candidates().find((x) => x.title.includes('HackX'));
      const jc = JSON.parse(env.deps.ledger.get(c!.key) ?? '{}');
      expect(jc.actionDate).toEqual({ date: '2026-10-20T00:00:00.000Z', kind: 'event' });
    } finally {
      await env.close();
    }
  });

  it('B3: an invalid deadline falls back to a valid, near event date and nudges on it', async () => {
    const invite = mail({
      id: 'm-nudge-b3',
      from: 'HackX <judges@hackxb3.example>',
      date: '2026-09-01T12:00:00Z',
      subject: 'Invitation to judge HackX',
      body: 'Hi Dara,\n\nPlease reply by September 31 to confirm. The event is on October 3, 2026.\n\nHackX',
    });
    const env = createHarnessEnv({
      seed: seed({ gmail: [invite] }),
      now: atLocalMorning('2026-09-29T16:00:00Z'), // 4 days before the valid event date
      gate: 'library',
      twilio: withSms(),
      extensions: () => [createNotifier()],
    });
    try {
      await env.run();
      const nudges = nudgeNotifications(env);
      expect(nudges.length).toBe(1);
      const textOut = env.deps.ledger.events({ kind: 'text_out' }).find((e) => e.detail.kind === 'nudge');
      expect(String(textOut?.detail.body)).toContain('event date');
      expect(String(textOut?.detail.body)).toContain('3 day');
    } finally {
      await env.close();
    }
  });

  it('B4: a quoted old deadline does not hide the real event date', async () => {
    const invite = mail({
      id: 'm-nudge-b4',
      from: 'NewHacks <judges@newhacksb4.example>',
      date: '2026-09-10T12:00:00Z',
      subject: 'Invitation to judge NewHacks',
      body:
        "Just following up!\n\n> On Aug 1, 2026 PastHacks wrote:\n> Please reply by August 5 to judge PastHacks.\n\n" +
        "We'd love you to judge NewHacks on September 18, 2026.",
    });
    const env = createHarnessEnv({
      seed: seed({ gmail: [invite] }),
      now: atLocalMorning('2026-09-14T16:00:00Z'), // 4 days before the real Sept 18 event
      gate: 'library',
      twilio: withSms(),
      extensions: () => [createNotifier()],
    });
    try {
      await env.run();
      const nudges = nudgeNotifications(env);
      expect(nudges.length).toBe(1);
      const textOut = env.deps.ledger.events({ kind: 'text_out' }).find((e) => e.detail.kind === 'nudge');
      expect(String(textOut?.detail.body)).toContain('event date');
      expect(String(textOut?.detail.body)).toContain('3 day');
    } finally {
      await env.close();
    }
  });

  it('a legacy JudgingCase with no actionDate key is backfilled from the invite text and nudges correctly', async () => {
    const invite = mail({
      id: 'm-nudge-legacy',
      from: 'HackX <judges@hackxlegacy.example>',
      date: '2026-08-01T12:00:00Z',
      subject: 'Invitation to judge HackX',
      body: "Hi Dara,\n\nWe'd love you to judge HackX on September 30, 2026. Please reply by September 17.\n\nHackX",
    });
    const env = createHarnessEnv({
      seed: seed({ gmail: [invite] }),
      now: atLocalMorning('2026-08-02T16:00:00Z'),
      gate: 'library',
      twilio: withSms(),
      extensions: () => [createNotifier()],
    });
    try {
      await env.run();
      const key = 'judging:hackxlegacy.example';
      const jc = JSON.parse(env.deps.ledger.get(key) ?? '{}');
      expect('actionDate' in jc).toBe(true);
      // Simulate a case ingested before actionDate parsing existed: strip the field entirely.
      delete jc.actionDate;
      env.deps.ledger.set(key, JSON.stringify(jc));

      env.clock.set(new Date('2026-09-14T16:00:00Z')); // just under 3 days before the Sept 17 deadline
      await env.run();

      const after = JSON.parse(env.deps.ledger.get(key) ?? '{}');
      expect(after.actionDate).toEqual({ date: '2026-09-17T00:00:00.000Z', kind: 'deadline' });
      const nudges = nudgeNotifications(env);
      expect(nudges.length).toBe(1);
      const textOut = env.deps.ledger.events({ kind: 'text_out' }).find((e) => e.detail.kind === 'nudge');
      expect(String(textOut?.detail.body)).toContain('reply deadline');
      expect(String(textOut?.detail.body)).toContain('2 day');
    } finally {
      await env.close();
    }
  });
});
