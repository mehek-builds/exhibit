import type { Apps, GmailMessage } from '../apps/types.js';
import { TwinExpiredError, TwinStubError } from '../apps/types.js';
import type { LetterRow, Ledger } from '../ledger.js';
import type { TraceContext } from '../observability/tracer.js';
import { O1_NAMES, oneExhibitFromMetCriteria } from '../binder/scorecard.js';
import { parseAddress } from '../pipeline/intake.js';
import type { ExhibitRecord, FounderProfile, O1Criterion, Recommender } from '../types.js';
import { daysBetween, isoDay, slug } from '../util.js';
import type { GateDecision, WorthSendingGate } from './worthSending.js';

// Letter requests (PRD 6.8, 6.9). Draft the full letter for the recommender to edit and sign,
// ask worth-sending, then the founder's approval. Nothing leaves without an APPROVE for that exact id.

export const ATTORNEY_OR_GOV = /(^|\.)(uscis\.gov|state\.gov|dhs\.gov|travel\.state\.gov|[\w-]*law\.(com|net|org)|[\w-]*legal\.(com|net|org)|[\w-]*immigration[\w-]*\.(com|net|org))$/i;

export interface LetterDeps {
  apps: Apps;
  ledger: Ledger;
  trace: TraceContext;
  profile: FounderProfile;
  gate: WorthSendingGate;
  runId: string;
  now: Date;
  allMessages: GmailMessage[];
  founderMessages: GmailMessage[];
}

export interface LetterSummary {
  evaluated: number;
  drafted: string[];
  held: { letter_id: string; reasons: string[] }[];
  approvalRequested: string[];
  sent: string[];
  skipped: { email: string; reason: string }[];
  decisions: { letter_id: string; decision: GateDecision['decision'] | 'error'; score: number | null }[];
  /** Apps that failed genuinely (not a twin stub/expiry) while drafting or sending (PRD 10). */
  degraded?: string[];
}

/** True for a real outage; twin-stub hits and twin expiry must still propagate (resilience.ts). */
function isTwinSignal(err: unknown): boolean {
  return err instanceof TwinStubError || err instanceof TwinExpiredError;
}

export function letterId(r: Recommender): string {
  return `LTR-${slug(r.email.split('@')[0]!)}`;
}

function linkedExhibits(r: Recommender, exhibits: ExhibitRecord[]): ExhibitRecord[] {
  const email = r.email.toLowerCase();
  return exhibits.filter((e) => e.status === 'qualifying' && e.people.some((p) => p.email?.toLowerCase() === email));
}

/**
 * Rule ids that mark a `needs_attorney` item as a failure of the pipeline itself rather than a
 * substantive borderline call: no source date anywhere (E25, verifier.ts `V-no-source-date`), a
 * hallucinated or not-found quote (E17, mapper.ts `V-quote-not-found`), and an unmapped or
 * model-failure route (E29, mapper.ts `N-unmapped`). None of these are evidence a recommender can
 * honestly speak to, so they must never seed a letter draft or be cited in one.
 */
const FAILURE_RULE_IDS = new Set(['V-no-source-date', 'V-quote-not-found', 'N-unmapped']);

/** True when a `needs_attorney` exhibit actually passed verification: it has at least one O-1A
 * criterion, a real source date, and a rule id that isn't one of the pipeline-failure routes above.
 * A `T-` prefixed rule id is a trap (prompts/fragments/traps.json's convention, applied by
 * src/rules/explicit.ts) -- deliberately ambiguous evidence a recommender cannot honestly speak to,
 * so it must never seed or support a letter draft even though it isn't a pipeline failure. */
function isVerifiedNeedsAttorney(e: ExhibitRecord): boolean {
  return e.criteria.length > 0 && !!e.event_date && !FAILURE_RULE_IDS.has(e.rule_id) && !e.rule_id.startsWith('T-');
}

/**
 * PRD 6.8: a letter request is also triggered for a criterion that is one exhibit from `met`, not only
 * one already `met` -- but only from a `needs_attorney` exhibit that actually passed verification
 * (isVerifiedNeedsAttorney) AND belongs to a criterion the scorecard itself marks one qualifying
 * exhibit short (6.7's own "building" computation, reused via oneExhibitFromMetCriteria). Exhibits
 * routed to needs_attorney by a pipeline failure (undated, hallucinated quote, unmapped/model-error, no
 * criteria at all) never trigger a request, and neither does a criterion that is already met. Rejected
 * items never trigger a request.
 */
function nearMissExhibits(r: Recommender, exhibits: ExhibitRecord[], almostMet: Set<O1Criterion>): ExhibitRecord[] {
  const email = r.email.toLowerCase();
  return exhibits.filter(
    (e) =>
      e.status === 'needs_attorney' &&
      isVerifiedNeedsAttorney(e) &&
      e.criteria.some((c) => almostMet.has(c)) &&
      e.people.some((p) => p.email?.toLowerCase() === email),
  );
}

/** Every exhibit the recommender can honestly speak to: exhibits for a criterion already `met`, plus
 * verified exhibits for a criterion one exhibit from `met` (PRD 6.8). Still requires worth-sending and
 * the founder's APPROVE for that exact letter id before anything sends. */
function letterTriggerExhibits(r: Recommender, exhibits: ExhibitRecord[], ledger: Ledger): ExhibitRecord[] {
  const almostMet = oneExhibitFromMetCriteria(ledger);
  const seen = new Set<string>();
  const combined = [...linkedExhibits(r, exhibits), ...nearMissExhibits(r, exhibits, almostMet)];
  return combined.filter((e) => (seen.has(e.exhibit_id) ? false : (seen.add(e.exhibit_id), true)));
}

export function draftLetter(r: Recommender, exhibits: ExhibitRecord[], profile: FounderProfile): string {
  const criteria = [...new Set(exhibits.flatMap((e) => e.criteria))].sort() as O1Criterion[];
  const metricLines = exhibits.flatMap((e) =>
    Object.entries(e.metrics)
      .filter(([k]) => k !== 'observed_at')
      .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v} (${e.exhibit_id}, observed ${e.metrics.observed_at ?? e.event_date ?? 'n.d.'})`),
  );
  return [
    `DRAFT for ${r.name} to edit and sign. Nothing here is final without your review. Every fact below comes from a dated exhibit; please correct anything that does not match your records.`,
    '',
    'To: U.S. Citizenship and Immigration Services',
    `Re: Letter in support of ${profile.name}`,
    '',
    '1. My expertise',
    `I am ${r.name}, ${r.role}. [Please add two or three sentences on your background and why you can evaluate work in ${profile.field}.]`,
    '',
    '2. How I know the work',
    ...exhibits.map((e) => `- ${e.title} (${e.issuer ?? 'issuer'}, ${e.event_date ?? 'undated'}; exhibit ${e.exhibit_id}).`),
    r.relationship === 'independent'
      ? `I know ${profile.name}'s work through these events rather than through a personal or working relationship.`
      : `I have worked with ${profile.name} directly in the context above.`,
    '',
    '3. Specific results',
    ...(metricLines.length ? metricLines.map((m) => `- ${m}`) : ['- [Add the specific results you observed.]']),
    '',
    '4. Standing in the field',
    `In my assessment, the work described above places ${profile.name} among the small percentage at the top of ${profile.field}. [Please state this in your own words, with the comparison you have in mind.]`,
    '',
    '5. Recommendation',
    `For the reasons above I support ${profile.name}'s petition. The exhibits cited relate to: ${criteria.map((c) => `#${c} ${O1_NAMES[c]}`).join('; ')}.`,
    '',
    `[Signature, title, organization, contact details]`,
  ].join('\n');
}

function askEmail(r: Recommender, exhibits: ExhibitRecord[], profile: FounderProfile, draft: string, revised: boolean): { subject: string; body: string } {
  return {
    subject: `Would you consider a recommendation letter for ${profile.name}?`,
    body: [
      `Hi ${r.name.split(' ')[0]},`,
      '',
      `I'm putting together evidence for a U.S. extraordinary-ability petition, and your view of ${exhibits.map((e) => `"${e.title}"`).join(' and ')} would carry real weight.`,
      revised
        ? 'The ask is one thing: read the draft below, change anything that does not match what you saw, and sign it if you are comfortable. It should take about 20 minutes, and there is no deadline this month.'
        : 'Would you be willing to review and sign a letter? I have drafted it below so you do not have to start from a blank page.',
      '',
      'If now is not a good time, no reply is needed.',
      '',
      `Thank you,\n${profile.name}`,
      '',
      '----- Draft letter -----',
      draft,
    ].join('\n'),
  };
}

function busySignal(r: Recommender, msgs: GmailMessage[], now: Date): GmailMessage | null {
  const email = r.email.toLowerCase();
  return (
    msgs
      .filter((m) => parseAddress(m.from).email === email && daysBetween(m.date, now.toISOString()) <= 7 && Date.parse(m.date) <= now.getTime())
      .find((m) => /\b(launch(?:ing)? this week|heads[- ]down|crunch|out of (?:the )?office|OOO|on leave|travel(?:l)?ing until)\b/i.test(`${m.subject}\n${m.body}`)) ?? null
  );
}

export function buildPacket(r: Recommender, exhibits: ExhibitRecord[], message: string, deps: Pick<LetterDeps, 'allMessages' | 'ledger' | 'profile' | 'now'>, id: string): Record<string, unknown> {
  const { now, profile } = deps;
  const email = r.email.toLowerCase();
  const threads = deps.allMessages.filter((m) => parseAddress(m.from).email === email || m.to.some((t) => parseAddress(t).email === email));
  const lastContact = threads.map((m) => m.date).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
  const priorAsks = deps.allMessages.filter((m) => m.labels.includes('SENT') && m.to.some((t) => parseAddress(t).email === email) && /recommendation letter/i.test(m.subject)).length;
  const busy = busySignal(r, deps.allMessages, now);
  const iso = (d: string | null) => (d ? new Date(d).toISOString() : null);
  const monthsToFiling = Math.round((Date.parse(profile.targetFilingDate) - now.getTime()) / (30.4 * 86_400_000));

  const evidence: Record<string, unknown>[] = [
    { id: 'E-rel', fact: `${threads.length} prior email messages exchanged with ${r.name}; last contact ${isoDay(lastContact) ?? 'never'}.`, source: 'Gmail message history', observed_at: iso(lastContact) ?? now.toISOString(), scope: 'individual', kind: 'observed' },
    ...exhibits.map((e, i) => ({ id: `E-ex-${i + 1}`, fact: `${r.name} is a named contact on exhibit ${e.exhibit_id}: ${e.title} (${e.issuer}, ${e.event_date}).`, source: `Exhibit ledger ${e.exhibit_id}`, observed_at: e.captured_at, scope: 'individual', kind: 'observed' })),
    { id: 'E-ask', fact: `${priorAsks} prior recommendation-letter requests sent to ${r.name}.`, source: 'Gmail sent mail', observed_at: now.toISOString(), scope: 'individual', kind: 'observed' },
    busy
      ? { id: 'E-timing', fact: `${r.name} wrote on ${isoDay(busy.date)}: "${busy.subject}".`, source: `Gmail message ${busy.id}`, observed_at: iso(busy.date), scope: 'individual', kind: 'observed' }
      : { id: 'E-timing', fact: `No out-of-office, launch or crunch signal from ${r.name} in the last 7 days.`, source: 'Gmail message history', observed_at: now.toISOString(), scope: 'individual', kind: 'observed' },
    { id: 'E-timeline', fact: `Target filing date ${profile.targetFilingDate}, about ${monthsToFiling} months away; letters are typically gathered during 4 to 12 months of evidence building.`, source: 'Exhibit scorecard gap plan', observed_at: now.toISOString(), scope: 'individual', kind: 'inference' },
  ];
  const exIds = exhibits.map((_, i) => `E-ex-${i + 1}`);

  return {
    rubric_version: '0.1',
    message,
    evaluated_at: now.toISOString(),
    recipient_context: `${r.name}, ${r.role}. Named contact on ${exhibits.length} exhibit(s) about work they saw firsthand. Relationship: ${r.relationship}.`,
    delivery_context: `Email to ${r.email}. ${threads.length} prior messages; last contact ${isoDay(lastContact) ?? 'never'}; ${priorAsks} prior asks.${busy ? ` Recent signal: "${busy.subject}".` : ''}`,
    product_context: `Request ${id}: review and sign a recommendation letter for an O-1A petition. A full draft is included for the recommender to edit; nothing is final without their review.`,
    recipient_benefit: 'A low-effort way to recognize work the recipient evaluated firsthand; the included draft saves writing from scratch.',
    business_outcome: 'A signed letter toward the 5 to 8 letters the petition needs.',
    evidence,
    assessment: {
      checks: {
        claims_supported: { status: 'pass', reason: 'Every fact in the draft is drawn from a dated exhibit the recipient is named on.', evidence_ids: exIds },
        recipient_eligible: { status: 'pass', reason: 'The recipient is a named contact on at least one qualifying exhibit.', evidence_ids: exIds },
        action_still_needed: priorAsks === 0 ? { status: 'pass', reason: 'No letter has been requested from this recipient yet.', evidence_ids: ['E-ask'] } : { status: 'fail', reason: 'A letter was already requested.', evidence_ids: ['E-ask'] },
        delivery_allowed: threads.length > 0 ? { status: 'pass', reason: 'The recipient has corresponded with the founder by email.', evidence_ids: ['E-rel'] } : { status: 'unknown', reason: 'No prior email relationship.', evidence_ids: [] },
        contact_window_clear: priorAsks === 0 ? { status: 'pass', reason: 'No prior asks to this recipient.', evidence_ids: ['E-ask'] } : { status: 'fail', reason: 'Already asked.', evidence_ids: ['E-ask'] },
      },
      dimensions: {
        recipient_value: { rating: threads.length >= 2 ? 3 : 2, reason: threads.length >= 2 ? 'An existing relationship makes the ask proportionate.' : 'Thin relationship history.', evidence_ids: ['E-rel'] },
        relevance: { rating: 4, reason: 'The recipient evaluated the cited work firsthand.', evidence_ids: exIds },
        timing: busy ? { rating: 1, reason: 'The recipient signalled they are busy right now.', evidence_ids: ['E-timing'] } : { rating: 3, reason: 'No busy signal in the last week.', evidence_ids: ['E-timing'] },
        actionability: { rating: 4, reason: 'One clear action with a full draft attached.', evidence_ids: exIds },
        business_fit: { rating: 3, reason: 'A signed letter advances the petition timeline.', evidence_ids: ['E-timeline'] },
      },
      weakest_assumption: 'The recipient has time and is comfortable signing a letter of this kind.',
      success_measure: 'The recipient replies and returns a signed letter.',
    },
  };
}

export const APPROVAL_INSTRUCTION = 'To approve, reply with exactly this line:';

/**
 * The founder's APPROVE reply for this exact letter id. The agent's own approval requests carry the
 * same APPROVE line as copy text, so they are excluded by id and by their instruction marker; a
 * self-sent reply in real Gmail is labeled SENT too, so the label alone cannot tell them apart.
 */
export function approvalFor(id: string, requestedAt: string | null, agentMessageIds: Set<string>, founderMessages: GmailMessage[], profile: FounderProfile): GmailMessage | null {
  const own = profile.emails.map((e) => e.toLowerCase());
  const re = new RegExp(`^\\s*APPROVE\\s+${id.replace(/[-]/g, '\\-')}\\s*$`, 'mi');
  return (
    founderMessages
      .filter((m) => !agentMessageIds.has(m.id) && own.includes(parseAddress(m.from).email ?? ''))
      .filter((m) => {
        const unquoted = m.body.split(/\n>|\nOn .+wrote:/)[0] ?? m.body;
        return !unquoted.includes(APPROVAL_INSTRUCTION) && re.test(unquoted);
      })
      .filter((m) => !requestedAt || Date.parse(m.date) >= Date.parse(requestedAt) - 1000)
      .sort((a, b) => Date.parse(a.date) - Date.parse(b.date))[0] ?? null
  );
}

export async function processLetters(deps: LetterDeps): Promise<LetterSummary> {
  const { apps, ledger, trace, profile, gate, runId, now } = deps;
  const summary: LetterSummary = { evaluated: 0, drafted: [], held: [], approvalRequested: [], sent: [], skipped: [], decisions: [], degraded: [] };
  const exhibits = ledger.exhibits();
  const markDegraded = (app: string) => {
    if (!summary.degraded!.includes(app)) summary.degraded!.push(app);
  };

  for (const r of profile.recommenderCandidates) {
    const id = letterId(r);
    const linked = letterTriggerExhibits(r, exhibits, ledger);
    if (linked.length === 0) {
      summary.skipped.push({ email: r.email, reason: 'no linked qualifying exhibit' });
      continue;
    }
    const recipientDomain = r.email.split('@')[1] ?? '';
    if (ATTORNEY_OR_GOV.test(recipientDomain)) {
      summary.skipped.push({ email: r.email, reason: 'attorney or government domain (constraint 2)' });
      continue;
    }
    const prior = ledger.letter(id);
    const row: LetterRow = prior ?? {
      letter_id: id,
      recommender_email: r.email,
      recommender_name: r.name,
      relationship: r.relationship,
      exhibit_ids: linked.map((e) => e.exhibit_id),
      doc_id: null,
      state: 'drafted',
      ws_decision: null,
      ws_score: null,
      ws_reasons: [],
      approval_msg_id: null,
      sent_msg_id: null,
      updated_run: runId,
      trace_id: trace.traceId,
    };
    if (row.state === 'sent') continue;
    // A pause set by text (6.13, E51) holds every letter, approved ones included, until it ends.
    const pausedUntil = ledger.get('letters_paused_until');
    if (pausedUntil && Date.parse(pausedUntil) > now.getTime()) {
      trace.span('letter.paused', { letter_id: id, until: pausedUntil }, { held: true });
      summary.skipped.push({ email: r.email, reason: `letter requests paused until ${pausedUntil}` });
      continue;
    }

    if (row.state === 'approval_requested') {
      const requestedAt = ledger.events({ kind: 'approval_requested' }).find((e) => e.detail.letter_id === id)?.at ?? null;
      const agentMessageIds = new Set([
        ...ledger.letters().flatMap((l) => [l.approval_msg_id, l.sent_msg_id].filter((x): x is string => !!x)),
        ...ledger.events({ kind: 'digest_sent' }).map((e) => String(e.detail.message_id)),
      ]);
      const approval = approvalFor(id, requestedAt, agentMessageIds, deps.founderMessages, profile);
      if (!approval) {
        trace.span('letter.pending_approval', { letter_id: id }, { approved: false });
        continue;
      }
      let draft: string;
      try {
        draft = row.doc_id ? await apps.docs.getText(row.doc_id) : draftLetter(r, linked, profile);
      } catch (err) {
        if (isTwinSignal(err)) throw err;
        trace.tool('docs.getText', { letter_id: id }, undefined, String(err));
        markDegraded('docs');
        continue;
      }
      const ask = askEmail(r, linked, profile, draft, row.ws_reasons.includes('revised'));
      let sent: { id: string };
      try {
        sent = await apps.gmail.send({ to: [r.email], subject: ask.subject, body: ask.body });
      } catch (err) {
        if (isTwinSignal(err)) throw err;
        trace.tool('gmail.send', { to: [r.email], subject: ask.subject, letter_id: id, kind: 'letter_request' }, undefined, String(err));
        markDegraded('gmail');
        continue;
      }
      trace.tool('gmail.send', { to: [r.email], subject: ask.subject, letter_id: id, approval_message_id: approval.id, kind: 'letter_request' }, { id: sent.id });
      ledger.upsertLetter({ ...row, state: 'sent', sent_msg_id: sent.id, updated_run: runId, trace_id: trace.traceId });
      ledger.event({ run_id: runId, trace_id: trace.traceId, kind: 'letter_sent', detail: { letter_id: id, message_id: sent.id, approval_message_id: approval.id }, at: now.toISOString() });
      summary.sent.push(id);
      continue;
    }

    // drafted or held: (re-)evaluate.
    let draft: string;
    try {
      if (row.doc_id) {
        draft = await apps.docs.getText(row.doc_id);
      } else {
        draft = draftLetter(r, linked, profile);
        const { documentId } = await apps.docs.create(`Letter draft: ${r.name} (${id})`);
        await apps.docs.replaceText(documentId, draft);
        row.doc_id = documentId;
        trace.tool('docs.create', { letter_id: id }, { documentId });
        summary.drafted.push(id);
      }
    } catch (err) {
      if (isTwinSignal(err)) throw err;
      trace.tool('docs.create', { letter_id: id }, undefined, String(err));
      markDegraded('docs');
      continue;
    }

    let decision: GateDecision | null = null;
    let revised = false;
    try {
      let ask = askEmail(r, linked, profile, draft, false);
      decision = await gate.evaluate(buildPacket(r, linked, ask.body, deps, id));
      summary.evaluated += 1;
      trace.tool('worth_sending.evaluate_message', { letter_id: id, transport: gate.transport }, { decision: decision.decision, score: decision.score, reasons: decision.reasons });
      if (decision.decision === 'revise') {
        revised = true;
        ask = askEmail(r, linked, profile, draft, true);
        decision = await gate.evaluate(buildPacket(r, linked, ask.body, deps, id));
        summary.evaluated += 1;
        trace.tool('worth_sending.evaluate_message', { letter_id: id, transport: gate.transport, revision: 1 }, { decision: decision.decision, score: decision.score, reasons: decision.reasons });
        if (decision.decision !== 'send') decision = { ...decision, decision: 'hold', reasons: ['Second non-send after one revision.', ...decision.reasons] };
      }
    } catch (err) {
      trace.tool('worth_sending.evaluate_message', { letter_id: id, transport: gate.transport }, undefined, String(err));
      summary.decisions.push({ letter_id: id, decision: 'error', score: null });
      ledger.upsertLetter({ ...row, state: 'held', ws_decision: 'hold', ws_score: null, ws_reasons: [`worth-sending unavailable: ${String(err)}`], updated_run: runId, trace_id: trace.traceId });
      summary.held.push({ letter_id: id, reasons: ['worth-sending unavailable'] });
      continue;
    }
    summary.decisions.push({ letter_id: id, decision: decision.decision, score: decision.score });

    if (decision.decision === 'send') {
      const ask = askEmail(r, linked, profile, draft, revised);
      const to = profile.emails[0]!;
      let req: { id: string };
      try {
        req = await apps.gmail.send({
          to: [to],
          subject: `[Exhibit] Approve letter request ${id} to ${r.name}`,
          body: [
            `worth-sending recommends sending this letter request (score ${decision.score}).`,
            '',
            APPROVAL_INSTRUCTION,
            `APPROVE ${id}`,
            '',
            'Nothing is sent without that reply. The message that would go out:',
            '',
            `To: ${r.email}`,
            `Subject: ${ask.subject}`,
            '',
            ask.body,
          ].join('\n'),
        });
      } catch (err) {
        if (isTwinSignal(err)) throw err;
        trace.tool('gmail.send', { to: [to], letter_id: id, kind: 'approval_request_to_self' }, undefined, String(err));
        markDegraded('gmail');
        continue;
      }
      trace.tool('gmail.send', { to: [to], letter_id: id, kind: 'approval_request_to_self' }, { id: req.id });
      ledger.upsertLetter({ ...row, state: 'approval_requested', ws_decision: 'send', ws_score: decision.score, ws_reasons: revised ? ['revised', ...decision.reasons] : decision.reasons, approval_msg_id: req.id, updated_run: runId, trace_id: trace.traceId });
      ledger.event({ run_id: runId, trace_id: trace.traceId, kind: 'approval_requested', detail: { letter_id: id, message_id: req.id }, at: now.toISOString() });
      summary.approvalRequested.push(id);
    } else {
      const reasons = decision.reasons;
      if (!(prior?.state === 'held' && JSON.stringify(prior.ws_reasons) === JSON.stringify(reasons))) {
        ledger.event({ run_id: runId, trace_id: trace.traceId, kind: 'letter_held', detail: { letter_id: id, reasons, score: decision.score }, at: now.toISOString() });
      }
      ledger.upsertLetter({ ...row, state: 'held', ws_decision: decision.decision, ws_score: decision.score, ws_reasons: reasons, updated_run: runId, trace_id: trace.traceId });
      summary.held.push({ letter_id: id, reasons });
    }
  }
  return summary;
}
