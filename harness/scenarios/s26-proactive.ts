import { createNotifier } from '../../src/notify/notifier.js';
import { createTextChannel } from '../../src/text/channel.js';
import { HeuristicCommandParser } from '../../src/text/commands.js';
import { MemoryTwilio } from '../../src/twins/twilio.js';
import { DARA, E, mail, seed } from '../corpus.js';
import { prohibitedSideEffects } from '../grade.js';
import type { GradeCheck, Scenario } from '../scenarios.js';

// S26: proactive texts (PRD 4.1, 6.8, 6.13). No outgoing text during quiet hours without a send
// decision (S20's pass condition): a proactive attempt during quiet hours is deferred, never sent
// and never dropped. A reply to the founder's own inbound text is immediate, never gated as
// "proactive". The first-scorecard text, the Sunday digest and a time-sensitive nudge each pass
// worth-sending once outside quiet hours, with figure numbers produced by listFiguresText (so
// "approve 1" resolves to the figure the founder actually read). The WhatsApp Sandbox only accepts
// free-form proactive messages within 24 hours of the founder's last inbound message; once that
// window closes, a further proactive text is deferred for `window_closed`, never dropped and never
// duplicated on the next run.

function chk(name: string, pass: boolean, detail: string): GradeCheck {
  return { name, pass, detail };
}

// Saturday 23:30 America/Los_Angeles -- quiet hours (22:00-08:00). Note event_date is day-truncated
// (PRD 6.13/4.1 nudge math), so these times are chosen to stay well before the CodeCraft invite's
// day (2026-08-30, from E.codecraftUnanswered's fixed mail date) while still being within 7 days of it.
const RUN_A_QUIET = new Date('2026-08-23T06:30:00Z');
// Sunday 08:30 America/Los_Angeles -- just outside quiet hours; the founder's first inbound text.
const RUN_B_STATUS = new Date('2026-08-23T15:30:00Z');
// Sunday 09:05 America/Los_Angeles -- the digest hour.
const RUN_C_DIGEST = new Date('2026-08-23T16:05:00Z');
// Shortly after the digest, the founder replies to approve a figure.
const APPROVE_AT = new Date('2026-08-23T16:06:00Z');
const RUN_D_APPROVE = new Date('2026-08-23T16:07:00Z');
// +30h from the last inbound message: the WhatsApp 24h window has closed.
const RUN_E_WINDOW_CLOSED = new Date(APPROVE_AT.getTime() + 30 * 3600 * 1000);

// A second, later-dated unanswered judge invite (minimal noise): more than 7 days away at the
// Sunday runs, so it does not nudge then, but within 7 days by RUN_E, so it is the "new" proactive
// text that finds the WhatsApp window closed.
const GLOWFORGE_INVITE = mail({
  id: 'm-glowforge-invite',
  from: 'Glowforge Hacks <judges@glowforgehacks.example>',
  date: '2026-08-31T12:00:00Z',
  subject: 'Invitation to judge Glowforge Hacks',
  body: "Hi Dara,\n\nWe'd love to invite you to be a judge at Glowforge Hacks.\n\nGlowforge Hacks",
});

export function makeS26(): Scenario {
  let twilio: MemoryTwilio;
  let numberMapAfterDigest: Record<string, string> = {};
  let sentBeforeQuietRun = -1;
  let sentAfterQuietRun = -1;
  let sentAfterWindowClosedRun = -1;
  let sentAfterExtraRun = -1;
  let fig1Id: string | null = null;

  return {
    id: 'S26',
    title: 'proactive texts',
    core: false,
    gate: 'library',
    seed: () =>
      seed({
        gmail: [...E.hackmesa.gmail, ...E.buildnight.gmail, ...E.accelerator, ...E.podcast, ...E.press, ...E.codecraftUnanswered, GLOWFORGE_INVITE],
        calendar: [...E.hackmesa.calendar, ...E.buildnight.calendar],
      }),
    env: {
      now: RUN_A_QUIET,
      twilio: (env) => {
        twilio = new MemoryTwilio({ sender: 'whatsapp:+15550009999', now: env.clock.now, record: env.twins.recordOp.bind(env.twins) });
        return twilio;
      },
      extensions: () => [createTextChannel({ parser: new HeuristicCommandParser() }), createNotifier()],
    },
    play: async (ctx) => {
      const { env } = ctx;
      const founder = DARA.phone!;

      // Run A: Saturday 23:30 local, quiet hours. Nothing proactive goes out; every attempt defers.
      sentBeforeQuietRun = twilio.state().messages.filter((m) => m.direction === 'outbound').length;
      await env.run();
      sentAfterQuietRun = twilio.state().messages.filter((m) => m.direction === 'outbound').length;

      // Run B: Sunday 08:30 local. The founder texts first; her reply is immediate, not proactive.
      env.clock.set(RUN_B_STATUS);
      twilio.adminInbound(founder, 'status', RUN_B_STATUS.toISOString());
      await env.run();

      // Run C: Sunday 09:05 local, the digest hour. First scorecard, digest and nudge each pass
      // worth-sending and go out once (across run B and run C together -- the nudge is time-
      // sensitive and does not wait for the Sunday digest hour).
      env.clock.set(RUN_C_DIGEST);
      await env.run();
      const raw = env.ledger.get('text_figure_numbers');
      numberMapAfterDigest = raw ? (JSON.parse(raw) as Record<string, string>) : {};
      fig1Id = numberMapAfterDigest['1'] ?? null;

      // The founder replies "approve 1": the figure listed as 1 is the one that gets approved.
      env.clock.set(APPROVE_AT);
      twilio.adminInbound(founder, 'approve 1', APPROVE_AT.toISOString());
      env.clock.set(RUN_D_APPROVE);
      await env.run();

      // +30h with no further inbound: the WhatsApp window has closed. Any new proactive text
      // (the Glowforge nudge, now within 7 days) is deferred for window_closed.
      env.clock.set(RUN_E_WINDOW_CLOSED);
      await env.run();
      sentAfterWindowClosedRun = twilio.state().messages.filter((m) => m.direction === 'outbound').length;

      // Run immediately after, same clock, no new inbound: no duplicates.
      await env.run();
      sentAfterExtraRun = twilio.state().messages.filter((m) => m.direction === 'outbound').length;
    },
    grade: (ctx) => {
      const { env } = ctx;
      const checks: GradeCheck[] = [];
      const notifications = env.ledger.events({ kind: 'notification' });
      const textOut = env.ledger.events({ kind: 'text_out' });

      // No outgoing text during quiet hours without a send decision (S20's pass condition): run A
      // sent nothing, and every attempt in run A recorded a deferral, never a bare drop.
      checks.push(chk('nothing sent during quiet hours (run A)', sentAfterQuietRun === sentBeforeQuietRun, `${sentBeforeQuietRun} -> ${sentAfterQuietRun}`));
      const quietDeferrals = notifications.filter((e) => e.detail.quiet_hours === true && e.detail.sent === false);
      checks.push(chk('quiet-hours attempts recorded as deferred, not dropped', quietDeferrals.length >= 2, `${quietDeferrals.length}`));

      // The founder's own "status" text got an immediate reply, not gated by quiet hours or the
      // WhatsApp window (it is a reply, per PRD 6.13, not a proactive text).
      const statusReply = textOut.find((e) => e.detail.kind === 'reply' && /O-1A/.test(String(e.detail.body ?? '')));
      checks.push(chk('the "status" reply went out immediately', !!statusReply, JSON.stringify(statusReply?.detail)));

      // First scorecard, digest and nudge each passed worth-sending and went out exactly once.
      const sendsOf = (kind: string) => notifications.filter((e) => e.detail.kind === kind && e.detail.decision === 'send' && e.detail.sent === true);
      checks.push(chk('first_scorecard sent exactly once', sendsOf('first_scorecard').length === 1, `${sendsOf('first_scorecard').length}`));
      checks.push(chk('digest sent exactly once', sendsOf('digest').length === 1, `${sendsOf('digest').length}`));
      checks.push(chk('codecraft nudge sent exactly once', sendsOf('nudge').length === 1, `${sendsOf('nudge').length}`));

      // The digest's figure numbers came from listFiguresText: figure "1" is a real pending figure
      // id, and it is the exact one that "approve 1" applied.
      checks.push(chk('numbered figure list resolved a real figure id for "1"', !!fig1Id, String(fig1Id)));
      const fig1 = fig1Id ? env.ledger.figure(fig1Id) : null;
      checks.push(chk('the figure listed as "1" is the one "approve 1" approved', fig1?.status === 'approved', `${fig1?.status}`));

      // The WhatsApp 24h window: once it closes, a new proactive attempt (the Glowforge nudge) is
      // deferred for window_closed, not sent, and not dropped -- never resolved to a silent no-op.
      const windowClosed = notifications.filter((e) => e.detail.window_closed === true);
      checks.push(chk('a window_closed deferral was recorded once the 24h window closed', windowClosed.length >= 1, `${windowClosed.length}`));
      checks.push(chk('window_closed attempts were never sent', windowClosed.every((e) => e.detail.sent === false), JSON.stringify(windowClosed.map((e) => e.detail.sent))));
      checks.push(chk('nothing new went out once the window closed', sentAfterWindowClosedRun === sentAfterExtraRun, `${sentAfterWindowClosedRun} -> ${sentAfterExtraRun}`));
      const glowforgeSends = notifications.filter((e) => e.detail.kind === 'nudge' && e.detail.sent === true).length;
      checks.push(chk('at most the one (codecraft) nudge ever actually sent -- Glowforge stayed deferred', glowforgeSends === 1, `${glowforgeSends}`));

      // The re-run right after the window closed produced no duplicate sends of anything.
      checks.push(chk('re-run right after window-closed produced no new sends', sentAfterExtraRun === sentAfterWindowClosedRun, `${sentAfterWindowClosedRun} -> ${sentAfterExtraRun}`));

      checks.push(chk('prohibitedSideEffects(env) empty', prohibitedSideEffects(env).length === 0, JSON.stringify(prohibitedSideEffects(env))));
      return checks;
    },
  };
}

export const S26: Scenario = makeS26();
