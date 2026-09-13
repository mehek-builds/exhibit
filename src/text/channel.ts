import type { AgentExtension, ExtensionContext } from '../agent.js';
import type { TextMessage, TwilioApi } from '../apps/types.js';
import type { Scorecard } from '../binder/scorecard.js';
import { buildScorecard } from '../binder/scorecard.js';
import type { FigureRow, Ledger } from '../ledger.js';
import type { ReviewDeps, ReviewSummary } from '../review/queue.js';
import { decideFigure, figureCell } from '../review/queue.js';
import { conversationThreadId } from '../observability/tracer.js';
import { redactText } from '../pipeline/redact.js';

const CONVERSATION_GAP_MS = 30 * 60 * 1000;
import type { CommandParser, ParsedCommand } from './commands.js';
import { PARTIAL_SELECTION_RE } from './commands.js';

// The two-way text channel (PRD 6.13): approve, deny, pause and check status by SMS, exactly as the
// Sheet and worth-sending would allow -- never more (constraint 15). Every inbound and outbound
// message is recorded in trace and ledger, and re-runs never re-apply a message (idempotent by sid).

const CONFIRM_TTL_MS = 24 * 3600 * 1000;

function normalizeNumber(n: string): string {
  return n.replace(/^whatsapp:/i, '').trim();
}

function figureNumberMap(ledger: Ledger): Record<string, string> {
  const raw = ledger.get('text_figure_numbers');
  return raw ? (JSON.parse(raw) as Record<string, string>) : {};
}

function pendingFigureNumbers(ledger: Ledger): number[] {
  const map = figureNumberMap(ledger);
  return Object.entries(map)
    .filter(([, id]) => ledger.figure(id)?.status === 'pending')
    .map(([n]) => Number(n))
    .sort((a, b) => a - b);
}

function figureIdForNumber(n: number, ledger: Ledger): string | null {
  return figureNumberMap(ledger)[String(n)] ?? null;
}

function resolveFigures(spec: 'all' | number[], ledger: Ledger): string[] {
  const nums = spec === 'all' ? pendingFigureNumbers(ledger) : spec;
  const ids: string[] = [];
  for (const n of nums) {
    const id = figureIdForNumber(n, ledger);
    if (id && ledger.figure(id)?.status === 'pending' && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Writes kv text_figure_numbers (number -> FIG id) and the "N figures to review" text; used by the notifier. */
export function listFiguresText(figures: FigureRow[], ledger: Ledger): string {
  const map: Record<string, string> = {};
  const lines = figures.map((f, i) => {
    const n = i + 1;
    map[String(n)] = f.fig_id;
    return `${n}. ${f.fig_id} (${f.exhibit_id} #${f.criterion}): ${figureCell(f)}`;
  });
  ledger.set('text_figure_numbers', JSON.stringify(map));
  return [`${figures.length} figure${figures.length === 1 ? '' : 's'} to review:`, ...lines, 'Reply "approve <numbers>" or "approve all", or "deny <number> <reason>".'].join('\n');
}

function reviewDepsFrom(ctx: ExtensionContext): ReviewDeps {
  return { apps: ctx.deps.apps, ledger: ctx.deps.ledger, trace: ctx.trace, profile: ctx.deps.profile, binder: ctx.binder, runId: ctx.runId, now: ctx.now };
}

function emptyReviewSummary(): ReviewSummary {
  return { approved: [], denied: [], pending: [], flagged: [], digestSent: false, degraded: [] };
}

async function approveFigures(figIds: string[], ctx: ExtensionContext): Promise<ReviewSummary> {
  const summary = emptyReviewSummary();
  for (const id of figIds) {
    const fig = ctx.deps.ledger.figure(id);
    if (!fig) continue;
    await decideFigure(fig, 'approve', '', reviewDepsFrom(ctx), summary);
  }
  return summary;
}

function confirmationText(figIds: string[], ledger: Ledger): string {
  const lines = figIds.map((id) => {
    const f = ledger.figure(id);
    if (!f) return `${id}: not found`;
    const publishers = f.sources.map((s) => s.publisher).join(' and ');
    return `${f.fig_id} (${f.exhibit_id}): ${figureCell(f)}. Sources: ${publishers}.`;
  });
  return [`Approve all ${figIds.length} figures?`, ...lines, 'Reply yes to confirm.'].join('\n');
}

function applyResultText(summary: ReviewSummary): string {
  const parts: string[] = [];
  if (summary.approved.length) parts.push(`Approved: ${summary.approved.join(', ')}.`);
  for (const f of summary.flagged) parts.push(`${f.fig_id}: ${f.issue}.`);
  if (!parts.length) parts.push('Nothing left to apply.');
  return parts.join(' ');
}

function denyResultText(figId: string, summary: ReviewSummary): string {
  if (summary.denied.includes(figId)) return `Denied ${figId}.`;
  const flag = summary.flagged.find((f) => f.fig_id === figId);
  return flag ? `${figId}: ${flag.issue}.` : `${figId}: not applied.`;
}

function scorecardReplyText(sc: Scorecard, cmd: 'next' | 'status'): string {
  const base = `O-1A ${sc.o1Met} of 8, EB-1A ${sc.eb1Met} of 10. Next: ${sc.nextAction}`;
  if (cmd === 'next') return base;
  return `${base}. Figures: ${sc.figures.approved} approved, ${sc.figures.pending} pending. Letters: ${sc.letters.sent} sent, ${sc.letters.awaitingApproval} awaiting your approval, ${sc.letters.heldCount} held.`;
}

/** E55: read-only search of the ledger, the judging cases and this run's Gmail/Calendar context.
 * Never files or marks anything qualifying -- only reports what was found and what is missing. */
function addEvidenceReply(description: string, ctx: ExtensionContext): string {
  const { deps } = ctx;
  const words = [...new Set(description.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [])];
  if (!words.length) return "I couldn't pull any keywords from that. What's the event or publication, and roughly when?";
  const hits: string[] = [];

  for (const c of deps.ledger.candidates()) {
    const hay = `${c.title} ${c.issuer ?? ''}`.toLowerCase();
    if (words.some((w) => hay.includes(w))) hits.push(`${c.title} (${c.status}${c.exhibit_id ? `, ${c.exhibit_id}` : ''})`);
  }
  for (const ev of ctx.context.calendar) {
    const hay = `${ev.summary} ${ev.description ?? ''} ${ev.location ?? ''}`.toLowerCase();
    if (words.some((w) => hay.includes(w))) hits.push(`Calendar: "${ev.summary}" on ${(ev.start ?? '').slice(0, 10)}`);
  }
  for (const m of ctx.context.allMessages) {
    const hay = `${m.subject} ${m.body}`.toLowerCase();
    if (words.some((w) => hay.includes(w))) hits.push(`Email: "${m.subject}"`);
  }

  if (hits.length) {
    return `Found: ${[...new Set(hits)].slice(0, 3).join('; ')}. I can't mark anything qualifying from a text; I'll re-check it on the next run.`;
  }
  return "I don't see that in your Gmail or Calendar yet, so I can't file it. If it's a judging invite, a thank-you or a certificate, forward it and I'll pick it up on the next run.";
}

async function sendText(ctx: ExtensionContext, twilio: TwilioApi, to: string, body: string, kind: 'reply' | 'clarify' | 'confirm'): Promise<void> {
  const { deps, trace, runId, now } = ctx;
  const res = await twilio.send({ to, body });
  trace.tool('twilio.send', { to, kind }, { sid: res.sid });
  deps.ledger.event({ run_id: runId, trace_id: trace.traceId, kind: 'text_out', detail: { sid: res.sid, to, body: redactText(body).text, kind, quiet_hours: false }, at: now.toISOString() });
}

function logTextIn(ctx: ExtensionContext, msg: TextMessage, command: string | null, args: unknown, action: string): void {
  const { deps, trace, runId, now } = ctx;
  deps.ledger.event({ run_id: runId, trace_id: trace.traceId, kind: 'text_in', detail: { sid: msg.sid, from: msg.from, body: redactText(msg.body).text, command, args, action }, at: now.toISOString() });
}

async function applyCommand(cmd: ParsedCommand, ctx: ExtensionContext, twilio: TwilioApi, rawText: string): Promise<void> {
  const { deps } = ctx;
  const to = deps.profile.phone;
  if (!to) return;
  const wasStopped = deps.ledger.get('texts_stopped') === '1';
  const mute = wasStopped && cmd.kind !== 'start' && cmd.kind !== 'stop';
  const send = async (body: string, kind: 'reply' | 'clarify' | 'confirm') => {
    if (!mute) await sendText(ctx, twilio, to, body, kind);
  };

  switch (cmd.kind) {
    case 'unclear':
      await send(cmd.question, 'clarify');
      return;

    case 'stop':
      deps.ledger.set('texts_stopped', '1');
      await send('Texts stopped. Reply start to resume.', 'reply');
      return;

    case 'start':
      deps.ledger.set('texts_stopped', '');
      await send('Texts resumed.', 'reply');
      return;

    case 'pause':
      deps.ledger.set('letters_paused_until', new Date(cmd.until).toISOString());
      await send(`Letter requests paused until ${cmd.until}. Figures and filing continue.`, 'reply');
      return;

    case 'resume':
      deps.ledger.set('letters_paused_until', '');
      await send('Letter requests resumed.', 'reply');
      return;

    case 'approve': {
      const figs = resolveFigures(cmd.figures, deps.ledger);
      if (figs.length === 0) {
        await send("I don't have any figures waiting for your review right now.", 'reply');
        return;
      }
      // E53: approving more than one figure (or "approve all") needs a confirmed yes first.
      const confirmIrreversibleDisabled = (deps.ruleOptions?.disabled ?? []).includes('TX-confirm-irreversible');
      if (!confirmIrreversibleDisabled && (cmd.figures === 'all' || figs.length > 1)) {
        deps.ledger.set('text_pending_confirm', JSON.stringify({ figureIds: figs, createdAt: ctx.now.toISOString() }));
        await send(confirmationText(figs, deps.ledger), 'confirm');
        return;
      }
      const summary = await approveFigures(figs, ctx);
      await send(applyResultText(summary), 'reply');
      return;
    }

    case 'deny': {
      const figId = figureIdForNumber(cmd.figure, deps.ledger);
      const fig = figId ? deps.ledger.figure(figId) : null;
      if (!figId || !fig) {
        await send(`I don't have a figure numbered ${cmd.figure}.`, 'reply');
        return;
      }
      const summary = emptyReviewSummary();
      await decideFigure(fig, 'deny', cmd.reason, reviewDepsFrom(ctx), summary);
      await send(denyResultText(figId, summary), 'reply');
      return;
    }

    case 'yes': {
      // G3 defense-in-depth: a `yes` whose raw text still carries an exception/limit/partial
      // selection must never apply a staged approve-all/multi-figure confirmation, even if it
      // somehow reached here ungrounded (e.g. a parser regression). Ask, apply nothing.
      if (PARTIAL_SELECTION_RE.test(rawText)) {
        await send('To approve only some figures, reply approve <numbers>; to approve all, reply yes.', 'clarify');
        return;
      }
      const raw = deps.ledger.get('text_pending_confirm');
      if (!raw) {
        await send("I don't have anything pending your yes right now.", 'clarify');
        return;
      }
      deps.ledger.set('text_pending_confirm', '');
      const pending = JSON.parse(raw) as { figureIds: string[]; createdAt: string };
      if (ctx.now.getTime() - Date.parse(pending.createdAt) > CONFIRM_TTL_MS) {
        await send('That confirmation expired after 24 hours; please resend the approve.', 'reply');
        return;
      }
      const stillPending = pending.figureIds.filter((id) => deps.ledger.figure(id)?.status === 'pending');
      if (stillPending.length === 0) {
        await send('Nothing left to approve; those figures were already decided.', 'reply');
        return;
      }
      const summary = await approveFigures(stillPending, ctx);
      await send(applyResultText(summary), 'reply');
      return;
    }

    case 'next':
    case 'status': {
      const sc = buildScorecard(deps.ledger, deps.profile, ctx.now, { followers: ctx.context.followers, degraded: [], sharingWarnings: [] });
      await send(scorecardReplyText(sc, cmd.kind), 'reply');
      return;
    }

    case 'add_evidence':
      await send(addEvidenceReply(cmd.description, ctx), 'reply');
      return;
  }
}

async function handleMessage(ctx: ExtensionContext, twilio: TwilioApi, parser: CommandParser, msg: TextMessage, founderNumber: string): Promise<void> {
  const { deps } = ctx;
  const verifiedNumberDisabled = (deps.ruleOptions?.disabled ?? []).includes('TX-verified-number');
  if (!verifiedNumberDisabled && normalizeNumber(msg.from) !== founderNumber) {
    // E50, constraint 15: not the founder's verified number. Ignored and logged, no reply.
    logTextIn(ctx, msg, null, null, 'ignored_unknown_number');
    return;
  }

  // Privacy: the parser (model-backed or heuristic) only ever sees redacted text -- the raw
  // msg.body reaches nothing but the ledger's own redacted copy below (section 6.2).
  const redactedBody = redactText(msg.body).text;

  let commands: ParsedCommand[];
  try {
    commands = await parser.parse(redactedBody, { now: ctx.now, pendingFigureNumbers: pendingFigureNumbers(deps.ledger) });
  } catch (err) {
    commands = [{ kind: 'unclear', question: "I couldn't read that message. Could you resend it?" }];
    ctx.trace.tool('text.parse', { sid: msg.sid }, undefined, String(err));
  }

  if (commands.length === 0) {
    // E54, TX-data-not-instructions: an embedded instruction (or genuinely empty text) is data,
    // never a command. Logged, never replied to.
    logTextIn(ctx, msg, null, null, 'ignored_injection_or_empty');
    return;
  }

  logTextIn(ctx, msg, commands.map((c) => c.kind).join(','), commands, 'parsed');
  for (const cmd of commands) await applyCommand(cmd, ctx, twilio, redactedBody);
}

export function createTextChannel(opts: { parser: CommandParser }): AgentExtension {
  return {
    name: 'text-channel',

    async beforeClassify(ctx: ExtensionContext): Promise<void> {
      const { deps, trace, runId, now } = ctx;
      const twilio = deps.apps.twilio;
      if (!twilio) {
        deps.ledger.event({ run_id: runId, trace_id: trace.traceId, kind: 'integration_call', detail: { integration: 'twilio', status: 'not_configured' }, at: now.toISOString() });
        return;
      }

      const inbound = await twilio.listInbound();
      trace.tool('twilio.receive', {}, { count: inbound.length });

      const lastSid = deps.ledger.get('text_last_sid');
      const startIdx = inbound.findIndex((m) => m.sid === lastSid) + 1;
      const fresh = inbound.slice(startIdx);
      if (fresh.length === 0) return;

      const founderNumber = normalizeNumber(deps.profile.phone ?? '');
      for (const msg of fresh) {
        // PRD 6.10: each conversation (messages under 30 minutes apart) is its own threaded trace,
        // keyed by a hash that never contains the phone number, linked from the batch trace.
        const msgAt = new Date(Date.parse(msg.dateSent) || now.getTime());
        const lastAt = deps.ledger.get('text_conv_last_at');
        const priorStart = deps.ledger.get('text_conv_started_at');
        const startedAt = lastAt && priorStart && msgAt.getTime() - Date.parse(lastAt) < CONVERSATION_GAP_MS ? new Date(priorStart) : msgAt;
        deps.ledger.set('text_conv_started_at', startedAt.toISOString());
        deps.ledger.set('text_conv_last_at', msgAt.toISOString());
        const threadId = conversationThreadId(founderNumber, startedAt);
        await deps.tracer.conversation({ threadId, name: 'exhibit-text', input: { sid: msg.sid }, parentTrace: ctx.trace }, (msgTrace) =>
          handleMessage({ ...ctx, trace: msgTrace }, twilio, opts.parser, msg, founderNumber),
        );
        deps.ledger.set('text_last_sid', msg.sid);
      }
    },
  };
}
