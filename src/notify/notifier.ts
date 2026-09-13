import type { AgentExtension, ExtensionContext } from '../agent.js';
import type { CandidateRow, Ledger } from '../ledger.js';
import type { Scorecard } from '../binder/scorecard.js';
import type { TwilioApi } from '../apps/types.js';
import type { FounderProfile } from '../types.js';
import { listFiguresText } from '../text/channel.js';
import { DEFAULT_QUIET_HOURS, inQuietHours } from './quietHours.js';
import { buildSelfTextPacket } from './packets.js';
import type { NotifyKind, SelfTextFacts } from './packets.js';

// First-run flow and proactive notifications (PRD 4.1, 6.8, 6.13). Every proactive text is gated by
// worth-sending and by quiet hours; a `send` during quiet hours is deferred, never dropped, to the
// next allowed run. Re-runs never resend the same text (kv flags below).
//
// The figures a proactive text lists are always produced by listFiguresText (src/text/channel.ts),
// the same function the text channel uses to resolve "approve <n>" -- so the numbers the founder
// reads on her phone are guaranteed to be the numbers "approve 1" maps to (finding 1).
//
// The WhatsApp Sandbox only accepts free-form proactive messages within 24 hours of the founder's
// last inbound message (PRD 6.13). A proactive whatsapp send outside that window is deferred, never
// dropped, except the first-scorecard text, which falls back to email-to-self as it already does
// when no twilio is configured at all (finding 2).

const WHATSAPP_WINDOW_MS = 24 * 3600 * 1000;

export interface NotifierOptions {
  /** Local hour (0-23) on Sunday, in the founder's quiet-hours time zone, at or after which the weekly digest may send. Default 9. */
  sundayHourLocal?: number;
}

function normalizeNumber(n: string): string {
  return n.replace(/^whatsapp:/i, '').trim();
}

/** The timestamp (ms) of the founder's most recent inbound message on this Twilio sender, or null if none. */
async function lastInboundAt(twilio: TwilioApi, founderNumber: string): Promise<number | null> {
  const inbound = await twilio.listInbound();
  const want = normalizeNumber(founderNumber);
  let latest: number | null = null;
  for (const m of inbound) {
    if (normalizeNumber(m.from) !== want) continue;
    const t = Date.parse(m.dateSent);
    if (Number.isNaN(t)) continue;
    if (latest === null || t > latest) latest = t;
  }
  return latest;
}

function quietHoursOf(profile: FounderProfile) {
  return { ...DEFAULT_QUIET_HOURS, ...(profile.quietHours ?? {}) };
}

function reviewSheetLink(ledger: Ledger): string {
  const id = ledger.get('review_sheet');
  return id ? `https://docs.google.com/spreadsheets/d/${id}` : 'the review sheet (not created yet)';
}

/** Days from `now` to the date embedded in a candidate's own event date; null when it carries none. */
function daysUntil(dateStr: string | null, now: Date): number | null {
  if (!dateStr) return null;
  const t = Date.parse(dateStr);
  if (Number.isNaN(t)) return null;
  return (t - now.getTime()) / 86_400_000;
}

function buildBackfillText(): string {
  return 'Backfill finished.';
}

interface NudgeDate {
  date: string;
  kind: 'deadline' | 'event';
}

/** The date that should drive the time-sensitive nudge for an unanswered invite: its own reply
 * deadline or event date, parsed from the invite text at verify time (verifier.ts/inviteDate.ts)
 * and persisted alongside the judging case under the candidate's own ledger key -- no schema
 * churn on CandidateRow. Falls back to `event_date` (today's behaviour) when the invite carried no
 * parseable date of its own. */
function nudgeDateOf(ledger: Ledger, c: CandidateRow): NudgeDate | null {
  const raw = ledger.get(c.key);
  if (raw) {
    try {
      const jc = JSON.parse(raw) as { actionDate?: NudgeDate | null };
      if (jc.actionDate) return jc.actionDate;
    } catch {
      // fall through to event_date
    }
  }
  return c.event_date ? { date: c.event_date, kind: 'event' } : null;
}

function dateLabel(kind: NudgeDate['kind']): string {
  return kind === 'deadline' ? 'reply deadline' : 'event date';
}

function timeSensitiveLine(ledger: Ledger, candidates: CandidateRow[], now: Date): string | null {
  const soon = candidates
    .filter((c) => c.mapping.rule_id === 'C4-invite-unanswered')
    .map((c) => {
      const nd = nudgeDateOf(ledger, c);
      return { c, nd, days: nd ? daysUntil(nd.date, now) : null };
    })
    .filter((x): x is { c: CandidateRow; nd: NudgeDate; days: number } => x.days !== null && x.days >= 0 && x.days <= 7)
    .sort((a, b) => a.days - b.days)[0];
  if (!soon) return null;
  return `Time-sensitive: the judge invite "${soon.c.title}" is unanswered and its ${dateLabel(soon.nd.kind)} is ${Math.round(soon.days)} day(s) away.`;
}

/** Figures section of a proactive text: always listFiguresText's own numbering (finding 1), so
 * "approve 1" in a later reply resolves to the exact figure the founder just read. */
function figuresSection(ledger: Ledger): string {
  const pending = ledger.figures({ status: 'pending' });
  if (pending.length === 0) return `Nothing waiting for your review right now: ${reviewSheetLink(ledger)}`;
  return listFiguresText(pending, ledger);
}

/** PRD 4.1 step 3: "6 figures are waiting for your review: [link]" — a count and a link to the
 * Sheet, never the per-figure identity numbers (FIG-/EX- ids) that the digest and text-approve
 * flow use once the founder is already working the queue. */
function firstScorecardFiguresLine(ledger: Ledger): string {
  const pending = ledger.figures({ status: 'pending' });
  const link = reviewSheetLink(ledger);
  if (pending.length === 0) return `Nothing waiting for your review right now: ${link}`;
  return `${pending.length} figure${pending.length === 1 ? '' : 's'} are waiting for your review: ${link}`;
}

function buildFirstScorecardText(sc: Scorecard, ledger: Ledger, now: Date): string {
  const total = ledger.exhibits().length;
  const parts = [
    `Done. I found ${total} piece${total === 1 ? '' : 's'} of evidence you already have.`,
    `O-1A: ${sc.o1Met} of 8 criteria. EB-1A: ${sc.eb1Met} of 10.`,
    `Closest gap: ${sc.nextAction}.`,
  ];
  const ts = timeSensitiveLine(ledger, ledger.candidates(), now);
  if (ts) parts.push(ts);
  parts.push(firstScorecardFiguresLine(ledger));
  return parts.join(' ');
}

function buildDigestText(sc: Scorecard, ledger: Ledger, filedThisWeek: string[]): string {
  const parts = [
    filedThisWeek.length ? `This week I filed: ${filedThisWeek.join(', ')}.` : 'Nothing new was filed this week.',
    `Waiting for you: ${sc.letters.awaitingApproval} letter${sc.letters.awaitingApproval === 1 ? '' : 's'} to approve.`,
    figuresSection(ledger),
    `Next action: ${sc.nextAction}.`,
  ];
  return parts.join(' ');
}

function localWeekday(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(now);
}

function localHour(now: Date, timeZone: string): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(now));
}

interface DeliverResult {
  sent: boolean;
  deferred: boolean;
}

async function deliver(ctx: ExtensionContext, kind: NotifyKind, body: string, facts: SelfTextFacts, key: string | null): Promise<DeliverResult> {
  const { deps, now } = ctx;
  const { ledger, profile, apps } = deps;

  if (ledger.get('texts_stopped') === '1') {
    // E56: STOP mutes texts, but the weekly digest keeps arriving by email to the founder's own address.
    const self = profile.emails[0];
    if (kind === 'digest' && self) {
      const sent = await apps.gmail.send({ to: [self], subject: '[Exhibit] Your Sunday digest', body });
      ctx.trace.tool('gmail.send', { to: [self], kind: 'digest_email_after_stop' }, { id: sent.id });
      ledger.event({ run_id: ctx.runId, trace_id: ctx.trace.traceId, kind: 'notification', detail: { kind, channel: 'email', decision: 'send', score: null, reasons: ['texts_stopped: digest by email'], sent: true, quiet_hours: false, window_closed: false }, at: now.toISOString() });
      return { sent: true, deferred: false };
    }
    ledger.event({ run_id: ctx.runId, trace_id: ctx.trace.traceId, kind: 'notification', detail: { kind, channel: 'sms', decision: 'hold', score: null, reasons: ['texts_stopped'], sent: false, quiet_hours: false, window_closed: false }, at: now.toISOString() });
    return { sent: false, deferred: false };
  }

  const pendingKey = `notify_pending:${key ?? kind}`;
  const q = quietHoursOf(profile);
  if (inQuietHours(now, q)) {
    ledger.set(pendingKey, JSON.stringify({ kind, body, facts }));
    ledger.event({ run_id: ctx.runId, trace_id: ctx.trace.traceId, kind: 'notification', detail: { kind, channel: 'sms', decision: 'deferred', score: null, reasons: ['quiet hours'], sent: false, quiet_hours: true, window_closed: false }, at: now.toISOString() });
    return { sent: false, deferred: true };
  }
  ledger.set(pendingKey, '');

  const packet = buildSelfTextPacket(kind, body, facts, { ledger, profile, now });
  let decision: { decision: 'send' | 'revise' | 'hold'; score: number | null; reasons: string[] };
  try {
    const out = await deps.gate.evaluate(packet);
    decision = { decision: out.decision, score: out.score, reasons: out.reasons };
  } catch (err) {
    decision = { decision: 'hold', score: null, reasons: [`worth-sending unavailable: ${String(err)}`] };
  }

  if (decision.decision !== 'send') {
    ledger.event({ run_id: ctx.runId, trace_id: ctx.trace.traceId, kind: 'notification', detail: { kind, channel: apps.twilio ? channelOf(apps.twilio.sender) : 'email', decision: decision.decision, score: decision.score, reasons: decision.reasons, sent: false, quiet_hours: false, window_closed: false }, at: now.toISOString() });
    return { sent: false, deferred: false };
  }

  if (apps.twilio) {
    const twilio = apps.twilio;
    const to = profile.phone;
    if (!to) {
      ledger.event({ run_id: ctx.runId, trace_id: ctx.trace.traceId, kind: 'notification', detail: { kind, channel: channelOf(twilio.sender), decision: 'send', score: decision.score, reasons: [...decision.reasons, 'no founder phone on profile'], sent: false, quiet_hours: false, window_closed: false }, at: now.toISOString() });
      return { sent: false, deferred: false };
    }

    const channel = channelOf(twilio.sender);
    let windowOpen = true;
    if (channel === 'whatsapp') {
      const lastAt = await lastInboundAt(twilio, to);
      windowOpen = lastAt !== null && now.getTime() - lastAt <= WHATSAPP_WINDOW_MS;
    }

    if (windowOpen) {
      const res = await twilio.send({ to, body });
      ctx.trace.tool('twilio.send', { to, kind }, { sid: res.sid });
      ledger.event({ run_id: ctx.runId, trace_id: ctx.trace.traceId, kind: 'text_out', detail: { sid: res.sid, to, body, kind, ws_decision: decision.decision, quiet_hours: false }, at: now.toISOString() });
      ledger.event({ run_id: ctx.runId, trace_id: ctx.trace.traceId, kind: 'notification', detail: { kind, channel, decision: 'send', score: decision.score, reasons: decision.reasons, sent: true, quiet_hours: false, window_closed: false }, at: now.toISOString() });
      return { sent: true, deferred: false };
    }

    // WhatsApp Sandbox 24-hour window is closed. The first-scorecard text still needs to reach the
    // founder somehow, so it falls back to email-to-self exactly as it does with no twilio at all;
    // every other proactive kind is deferred (never dropped) to the next run.
    if (kind !== 'first_scorecard') {
      ledger.set(pendingKey, JSON.stringify({ kind, body, facts }));
      ledger.event({ run_id: ctx.runId, trace_id: ctx.trace.traceId, kind: 'notification', detail: { kind, channel, decision: 'send', score: decision.score, reasons: [...decision.reasons, 'window_closed'], sent: false, quiet_hours: false, window_closed: true }, at: now.toISOString() });
      return { sent: false, deferred: true };
    }
  }

  if (kind === 'first_scorecard') {
    const to = profile.emails[0];
    if (!to) return { sent: false, deferred: false };
    const sent = await apps.gmail.send({ to: [to], subject: '[Exhibit] Your first scorecard', body });
    ctx.trace.tool('gmail.send', { to: [to], kind: 'first_scorecard_fallback' }, { id: sent.id });
    ledger.event({ run_id: ctx.runId, trace_id: ctx.trace.traceId, kind: 'notification', detail: { kind, channel: 'email', decision: 'send', score: decision.score, reasons: decision.reasons, sent: true, quiet_hours: false }, at: now.toISOString() });
    return { sent: true, deferred: false };
  }

  ledger.event({ run_id: ctx.runId, trace_id: ctx.trace.traceId, kind: 'notification', detail: { kind, channel: 'sms', decision: 'send', score: decision.score, reasons: [...decision.reasons, 'no twilio configured'], sent: false, quiet_hours: false }, at: now.toISOString() });
  return { sent: false, deferred: false };
}

function channelOf(sender: string): 'whatsapp' | 'sms' {
  return sender.startsWith('whatsapp:') ? 'whatsapp' : 'sms';
}

export function createNotifier(opts: NotifierOptions = {}): AgentExtension {
  const sundayHourLocal = opts.sundayHourLocal ?? 9;

  return {
    name: 'notifier',

    async afterScorecard(ctx: ExtensionContext): Promise<void> {
      const { deps, now, summary } = ctx;
      const { ledger, profile } = deps;

      // Step 2: backfill completion, once.
      if (!ledger.get('backfill_done_at')) {
        const r = await deliver(ctx, 'backfill_done', buildBackfillText(), {}, null);
        if (!r.deferred) ledger.set('backfill_done_at', now.toISOString());
      }

      // Step 3: the first-scorecard text, once, with real numbers from this run's scorecard.
      if (!ledger.get('first_scorecard_sent') && summary.scorecard) {
        const sc = summary.scorecard;
        const body = buildFirstScorecardText(sc, ledger, now);
        const r = await deliver(ctx, 'first_scorecard', body, { pendingFigures: sc.figures.pending }, null);
        if (!r.deferred) ledger.set('first_scorecard_sent', '1');
      }

      // Time-sensitive nudge: an unanswered judge invite whose reply deadline (or, failing that,
      // event date) is within 7 days -- and still in the future.
      for (const c of ledger.candidates()) {
        if (c.mapping.rule_id !== 'C4-invite-unanswered') continue;
        const nd = nudgeDateOf(ledger, c);
        const days = nd ? daysUntil(nd.date, now) : null;
        if (days === null || days < 0 || days > 7) continue;
        const flag = `nudge_sent:${c.key}`;
        if (ledger.get(flag)) continue;
        const body = `Reminder: the judge invite "${c.title}" from ${c.issuer ?? 'the organizer'} has not been answered, and its ${dateLabel(nd!.kind)} is ${Math.round(days)} day(s) away.`;
        const r = await deliver(ctx, 'nudge', body, { replyDeadlineDays: days }, c.key);
        if (!r.deferred) ledger.set(flag, '1');
      }

      // Sunday digest: local time is Sunday at or after sundayHourLocal, and the last digest was >= 6 days ago.
      const q = { ...DEFAULT_QUIET_HOURS, ...(profile.quietHours ?? {}) };
      if (localWeekday(now, q.timeZone) === 'Sun' && localHour(now, q.timeZone) >= sundayHourLocal) {
        const lastAt = ledger.get('last_digest_at');
        const daysSince = lastAt ? (now.getTime() - Date.parse(lastAt)) / 86_400_000 : null;
        if (daysSince === null || daysSince >= 6) {
          const sc = summary.scorecard;
          if (sc) {
            const filedThisRun = summary.filed;
            const hasNews = filedThisRun.length > 0 || sc.figures.pending > 0 || sc.letters.awaitingApproval > 0;
            const body = buildDigestText(sc, ledger, filedThisRun);
            const r = await deliver(ctx, 'digest', body, { daysSinceLastDigest: daysSince, hasNews }, null);
            if (r.sent) ledger.set('last_digest_at', now.toISOString());
          }
        }
      }
    },
  };
}
