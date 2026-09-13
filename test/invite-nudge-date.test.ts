import { describe, expect, it } from 'vitest';
import { createNotifier } from '../src/notify/notifier.js';
import { MemoryTwilio } from '../src/twins/twilio.js';
import { DARA, fullYearSeed, mail, NOW, seed } from '../harness/corpus.js';
import { createHarnessEnv } from '../harness/env.js';
import { TwinStubError } from '../src/apps/types.js';
import { failAll, failingApp } from '../harness/faults.js';

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

  // Regression tests for review findings R1 (reply-intent regex), R2 (Gmail outage during
  // backfill), R3 (forwarded legacy invite), and the efficiency follow-up (backfill must not
  // re-list the mailbox per legacy case).

  it('R1: a false "confirm your travel arrangements by" deadline never nudges; the real event date does, later', async () => {
    const invite = mail({
      id: 'm-nudge-r1',
      from: 'HackX <judges@hackxr1.example>',
      date: '2026-08-01T12:00:00Z',
      subject: 'Invitation to judge HackX',
      body:
        "Hi Dara,\n\nWe'd love you to judge HackX on October 20, 2026. Please confirm your travel arrangements by September 16.\n\nHackX",
    });
    const env = createHarnessEnv({
      seed: seed({ gmail: [invite] }),
      now: atLocalMorning('2026-09-14T16:00:00Z'), // 2 days before the fake "deadline"; the real event is 36 days out
      gate: 'library',
      twilio: withSms(),
      extensions: () => [createNotifier()],
    });
    try {
      await env.run();
      expect(nudgeNotifications(env).length).toBe(0);
      const c = env.deps.ledger.candidates().find((x) => x.title.includes('HackX'));
      const jc = JSON.parse(env.deps.ledger.get(c!.key) ?? '{}');
      expect(jc.actionDate).toEqual({ date: '2026-10-20T00:00:00.000Z', kind: 'event' });
    } finally {
      await env.close();
    }
  });

  it('R1: "get back to us by" is restored as a reply deadline and nudges', async () => {
    const invite = mail({
      id: 'm-nudge-r1-getback',
      from: 'HackX <judges@hackxgetback.example>',
      date: '2026-08-01T12:00:00Z',
      subject: 'Invitation to judge HackX',
      body: 'Hi Dara,\n\nWould you judge HackX? Please get back to us by September 17.\n\nHackX',
    });
    const env = createHarnessEnv({
      seed: seed({ gmail: [invite] }),
      now: atLocalMorning('2026-09-14T16:00:00Z'), // 3 days before the deadline
      gate: 'library',
      twilio: withSms(),
      extensions: () => [createNotifier()],
    });
    try {
      await env.run();
      const nudges = nudgeNotifications(env);
      expect(nudges.length).toBe(1);
      const textOut = env.deps.ledger.events({ kind: 'text_out' }).find((e) => e.detail.kind === 'nudge');
      expect(String(textOut?.detail.body)).toContain('reply deadline');
    } finally {
      await env.close();
    }
  });

  it('R2: a Gmail outage during backfill leaves a legacy case unstamped; the next run, once Gmail recovers, backfills and nudges', async () => {
    const invite = mail({
      id: 'm-nudge-r2',
      from: 'HackX <judges@hackxr2.example>',
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
      const key = 'judging:hackxr2.example';
      const jc = JSON.parse(env.deps.ledger.get(key) ?? '{}');
      expect('actionDate' in jc).toBe(true);
      // Simulate a legacy case: strip the field entirely.
      delete jc.actionDate;
      env.deps.ledger.set(key, JSON.stringify(jc));

      // Gmail goes down (a real outage, not a twin signal) just before the deadline.
      const downApps = failingApp(env.deps.apps, 'gmail', 'throw');
      env.deps.apps = downApps;
      env.clock.set(new Date('2026-09-14T16:00:00Z')); // 3 days before the Sept 17 deadline
      const degradedSummary = await env.run();
      expect(degradedSummary.degraded).toContain('gmail');

      const stillLegacy = JSON.parse(env.deps.ledger.get(key) ?? '{}');
      expect('actionDate' in stillLegacy).toBe(false);
      // event_date (the invite's own stale send date) never produces a false nudge while down.
      expect(nudgeNotifications(env).filter((e) => e.run_id === degradedSummary.runId).length).toBe(0);

      // Gmail recovers.
      downApps.fault.down = false;
      env.clock.advance(1000);
      await env.run();

      const after = JSON.parse(env.deps.ledger.get(key) ?? '{}');
      expect(after.actionDate).toEqual({ date: '2026-09-17T00:00:00.000Z', kind: 'deadline' });
      const nudges = nudgeNotifications(env);
      expect(nudges.filter((e) => e.detail.sent === true).length).toBe(1);
    } finally {
      await env.close();
    }
  });

  it('R3: a forwarded legacy invite is backfilled from the unwrapped original, not the raw forward, and nudges', async () => {
    const forwarded = mail({
      id: 'm-nudge-r3-fwd',
      from: 'A Friend <friend@example.com>',
      date: '2026-08-05T12:00:00Z',
      subject: 'Fwd: Invitation to judge HackX',
      body:
        'Dara, thought you\'d want to see this!\n\n' +
        '---------- Forwarded message ----------\n' +
        'From: HackX <judges@hackxr3fwd.example>\n' +
        'Date: Sat, 1 Aug 2026 12:00:00 -0700\n' +
        'Subject: Invitation to judge HackX\n' +
        'To: <dara@loomwork.example>\n\n' +
        "Hi Dara,\n\nWe'd love you to judge HackX on September 30, 2026. Please reply by September 17.\n\nHackX",
    });
    const env = createHarnessEnv({
      seed: seed({ gmail: [forwarded] }),
      now: atLocalMorning('2026-08-06T16:00:00Z'),
      gate: 'library',
      twilio: withSms(),
      extensions: () => [createNotifier()],
    });
    try {
      await env.run();
      const key = 'judging:hackxr3fwd.example';
      const jc = JSON.parse(env.deps.ledger.get(key) ?? '{}');
      expect('actionDate' in jc).toBe(true);
      // Simulate a legacy case ingested before actionDate parsing existed.
      delete jc.actionDate;
      env.deps.ledger.set(key, JSON.stringify(jc));

      env.clock.set(new Date('2026-09-14T16:00:00Z')); // 3 days before the Sept 17 deadline
      await env.run();

      const after = JSON.parse(env.deps.ledger.get(key) ?? '{}');
      // Backfilling the raw forward (bug) would strip everything from "Forwarded message" onward
      // and find nothing; backfilling the unwrapped original recovers the real deadline.
      expect(after.actionDate).toEqual({ date: '2026-09-17T00:00:00.000Z', kind: 'deadline' });
      const nudges = nudgeNotifications(env);
      expect(nudges.length).toBe(1);
    } finally {
      await env.close();
    }
  });

  it('efficiency: backfilling 4 legacy cases in one run makes zero extra Gmail list calls (reuses the run\'s own intake read)', async () => {
    const invites = ['a', 'b', 'c', 'd'].map((letter, i) =>
      mail({
        id: `m-nudge-eff-${letter}`,
        from: `HackX ${letter} <judges@hackxeff${letter}.example>`,
        date: '2026-08-01T12:00:00Z',
        subject: `Invitation to judge HackX${letter}`,
        body: `Hi Dara,\n\nWe'd love you to judge HackX${letter} on September ${20 + i}, 2026. Please reply by September ${17 + i}.\n\nHackX${letter}`,
      }),
    );
    const env = createHarnessEnv({
      seed: seed({ gmail: invites }),
      now: atLocalMorning('2026-08-02T16:00:00Z'),
      gate: 'library',
      twilio: withSms(),
      extensions: () => [createNotifier()],
    });
    try {
      await env.run();
      const keys = ['a', 'b', 'c', 'd'].map((letter) => `judging:hackxeff${letter}.example`);
      for (const key of keys) {
        const jc = JSON.parse(env.deps.ledger.get(key) ?? '{}');
        expect('actionDate' in jc).toBe(true);
        delete jc.actionDate;
        env.deps.ledger.set(key, JSON.stringify(jc));
      }

      // Spy on the raw call count for the next run, which must backfill all 4 legacy cases.
      let calls = 0;
      const orig = env.deps.apps.gmail.listMessages.bind(env.deps.apps.gmail);
      env.deps.apps.gmail.listMessages = () => {
        calls += 1;
        return orig();
      };

      env.clock.advance(1000);
      await env.run();

      // Exactly the one call intake itself always makes -- zero extra from backfilling 4 cases.
      expect(calls).toBe(1);
      for (const key of keys) {
        const after = JSON.parse(env.deps.ledger.get(key) ?? '{}');
        expect('actionDate' in after).toBe(true);
        expect(after.actionDate).not.toBeNull();
      }
    } finally {
      await env.close();
    }
  });

  it('R2: a twin stub hit during a run with a pending legacy case still propagates and leaves the case untouched', async () => {
    const invite = mail({
      id: 'm-nudge-stub',
      from: 'HackX <judges@hackxstub.example>',
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
      const key = 'judging:hackxstub.example';
      const jc = JSON.parse(env.deps.ledger.get(key) ?? '{}');
      delete jc.actionDate;
      env.deps.ledger.set(key, JSON.stringify(jc));

      env.deps.apps.gmail = failAll(env.deps.apps.gmail, () => new TwinStubError('gmail/messages.list'));
      env.clock.set(new Date('2026-09-14T16:00:00Z'));

      let caught: unknown;
      try {
        await env.run();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(TwinStubError);

      const stillLegacy = JSON.parse(env.deps.ledger.get(key) ?? '{}');
      expect('actionDate' in stillLegacy).toBe(false);
    } finally {
      await env.close();
    }
  });

  it('no proactive text ever contains "[object Promise]" (review sanity check)', async () => {
    const invite = mail({
      id: 'm-nudge-promise',
      from: 'HackX <judges@hackxpromise.example>',
      date: '2026-08-01T12:00:00Z',
      subject: 'Invitation to judge HackX',
      body: "Hi Dara,\n\nWe'd love you to judge HackX on September 30, 2026. Please reply by September 17.\n\nHackX",
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
      const outs = env.deps.ledger.events({ kind: 'text_out' }).map((e) => String(e.detail.body));
      expect(outs.join('\n')).not.toContain('[object Promise]');
    } finally {
      await env.close();
    }
  });
});
