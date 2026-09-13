import type { DocsApi } from '../apps/types.js';
import { TwinExpiredError, TwinStubError } from '../apps/types.js';
import type { CandidateRow, Ledger, LetterRow } from '../ledger.js';
import { O1_TO_EB1 } from '../rules/explicit.js';
import type { Eb1Criterion, ExhibitRecord, FounderProfile, O1Criterion } from '../types.js';
import { daysBetween, isoDay } from '../util.js';

// Scorecard and gap plan (PRD 6.7), regenerated from the ledger on every run. It says which working
// rules are met; it never says the founder qualifies (constraint 10).

export type CellState = 'met' | 'building' | 'empty';

export const O1_NAMES: Record<O1Criterion, string> = {
  1: 'Awards',
  2: 'Membership',
  3: 'Published material',
  4: 'Judging',
  5: 'Original contributions',
  6: 'Scholarly articles',
  7: 'Critical role',
  8: 'Remuneration',
};

export interface CriterionRow {
  o1: O1Criterion;
  eb1: Eb1Criterion;
  name: string;
  o1State: CellState;
  eb1State: CellState;
  exhibits: string[];
  building: string[];
  nextAction: string | null;
}

export interface Scorecard {
  generatedAt: string;
  rows: CriterionRow[];
  eb1Only: { criterion: Eb1Criterion; state: CellState; exhibits: string[] }[];
  o1Met: number;
  eb1Met: number;
  nextAction: string;
  warnings: string[];
  goTrigger: { criteriaMet: number; thirdPartyPress: number; followers: number | null };
  gap: { targetFilingDate: string; monthsLeft: number; note: string };
  letters: {
    drafted: number;
    heldCount: number;
    awaitingApproval: number;
    sent: number;
    dependent: number;
    independent: number;
    holdReasons: string[];
    /** PRD 6.8: the brief reports the hold rate and top hold reasons, computed from the letters ledger. */
    evaluated: number;
    holdRate: number | null;
    topHoldReasons: { reason: string; count: number }[];
  };
  /** PRD 6.7: the gap against the 5 to 8 letter target and its dependent-versus-independent mix, counted
   * from signed letters (6.14) -- a drafted or sent ask is not yet evidence the petition can use. */
  lettersGap: string;
  notCounted: Record<string, number>;
  figures: { pending: number; approved: number; denied: number; gaps: string[] };
  sharingWarnings: string[];
  degraded: string[];
  signatures?: {
    created: number;
    signed: number;
    declined: number;
    expired: number;
    rows: { letterId: string; status: 'created' | 'signed' | 'declined' | 'expired'; signerEmail: string; nextAction: string | null }[];
  };
  translation?: { needingTranslation: number; draftsProduced: number; waitingForOptIn: number };
  tamperEvidence?: {
    stamped: number;
    confirmed: number;
    pending: number;
    lastVerify: { filesChecked: number; passed: number; failed: string[] } | null;
  };
  discovery?: { source: string; found: number; rejected: number; merged: number }[];
  textThread?: { lettersPausedUntil: string | null; textsStopped: boolean };
  deferred?: { integrations: string[]; count: number };
}

/** Letters for signature (6.14), from `signature` events (kv `sign:<letterId>` is the live state; the
 * ledger event stream is the authoritative history the scorecard reads). Declined/expired requests are
 * reported as returned to the scorecard (E66), with the next action spelled out. */
function buildSignatures(ledger: Ledger): NonNullable<Scorecard['signatures']> {
  const latest = new Map<string, { status: string; signerEmail: string }>();
  for (const e of ledger.events({ kind: 'signature' })) {
    const d = e.detail as { letter_id: string; status: string; signer_email: string };
    if (!d.letter_id) continue;
    latest.set(d.letter_id, { status: d.status, signerEmail: d.signer_email });
  }
  const rows = [...latest.entries()].map(([letterId, v]) => ({
    letterId,
    status: v.status as 'created' | 'signed' | 'declined' | 'expired',
    signerEmail: v.signerEmail,
    nextAction: v.status === 'declined' || v.status === 'expired' ? 'ask again or choose another recommender' : null,
  }));
  return {
    created: rows.filter((r) => r.status === 'created').length,
    signed: rows.filter((r) => r.status === 'signed').length,
    declined: rows.filter((r) => r.status === 'declined').length,
    expired: rows.filter((r) => r.status === 'expired').length,
    rows,
  };
}

/** Translation (6.14, E67): counts from `translation` events. Every event represents an item that
 * needs a certified translation for filing; `opted_in && called` is a machine draft actually produced;
 * `!opted_in` is an item waiting on `profile.translationOptIn` (no DeepL call was made). */
function buildTranslation(ledger: Ledger): NonNullable<Scorecard['translation']> {
  const events = ledger.events({ kind: 'translation' });
  let draftsProduced = 0;
  let waitingForOptIn = 0;
  for (const e of events) {
    const d = e.detail as { opted_in: boolean; called: boolean };
    if (d.opted_in && d.called) draftsProduced++;
    if (!d.opted_in) waitingForOptIn++;
  }
  return { needingTranslation: events.length, draftsProduced, waitingForOptIn };
}

/** Tamper-evidence (6.14, E63): `timestamp` events per file (latest status wins: confirmed vs still
 * pending on Bitcoin confirmation), plus the last `verify` event's result and any failed file named. */
function buildTamperEvidence(ledger: Ledger): NonNullable<Scorecard['tamperEvidence']> {
  const latest = new Map<string, string>();
  for (const e of ledger.events({ kind: 'timestamp' })) {
    const d = e.detail as { file_id: string; status: string };
    if (!d.file_id) continue;
    latest.set(d.file_id, d.status);
  }
  const statuses = [...latest.values()];
  const verifyEvents = ledger.events({ kind: 'verify' });
  const lastVerifyEvent = verifyEvents[verifyEvents.length - 1];
  const lastVerify = lastVerifyEvent
    ? (() => {
        const d = lastVerifyEvent.detail as { files_checked: number; passed: number; failed: { path: string; reason: string }[] };
        return { filesChecked: d.files_checked, passed: d.passed, failed: (d.failed ?? []).map((f) => f.path) };
      })()
    : null;
  return {
    stamped: statuses.length,
    confirmed: statuses.filter((s) => s === 'confirmed').length,
    pending: statuses.filter((s) => s !== 'confirmed').length,
    lastVerify,
  };
}

/** Discovery (6.14): `discovery` events per source, split by outcome — candidates found, rejected by
 * the second-identifier rule, and merged as a duplicate of an existing inbox item. */
function buildDiscovery(ledger: Ledger): NonNullable<Scorecard['discovery']> {
  const bySource = new Map<string, { found: number; rejected: number; merged: number }>();
  for (const e of ledger.events({ kind: 'discovery' })) {
    const d = e.detail as { source: string; outcome: 'second_identifier_reject' | 'duplicate' | 'candidate' };
    const row = bySource.get(d.source) ?? { found: 0, rejected: 0, merged: 0 };
    if (d.outcome === 'candidate') row.found++;
    else if (d.outcome === 'second_identifier_reject') row.rejected++;
    else if (d.outcome === 'duplicate') row.merged++;
    bySource.set(d.source, row);
  }
  return [...bySource.entries()].map(([source, v]) => ({ source, ...v }));
}

/** PRD 6.7: the gap against the 5 to 8 letter target and its dependent-versus-independent mix,
 * counted by what's actually signed (6.14) -- a draft or a sent ask is not filing evidence yet, so
 * counting those would overstate progress. Never says the founder qualifies (constraint 10). */
function buildLettersGap(letters: LetterRow[], signatures: NonNullable<Scorecard['signatures']>): string {
  const signedIds = new Set(signatures.rows.filter((r) => r.status === 'signed').map((r) => r.letterId));
  const signed = letters.filter((l) => signedIds.has(l.letter_id));
  const independentSigned = signed.filter((l) => l.relationship === 'independent').length;
  const neededTotal = Math.max(0, 5 - signed.length);
  const neededIndependent = Math.max(0, 1 - independentSigned);
  if (neededTotal === 0) {
    return `Letters gap: target met, ${signed.length} of 5 to 8 signed (${independentSigned} independent expert${independentSigned === 1 ? '' : 's'}).`;
  }
  const independentNote = neededIndependent > 0 ? `, including ${neededIndependent} independent expert${neededIndependent > 1 ? 's' : ''}` : '';
  return `Letters gap: need ${neededTotal} more${independentNote} (${signed.length} of 5 to 8 signed).`;
}

/** Text thread (6.13) state from kv: paused-until date for letter requests, and whether the founder
 * texted STOP. */
function buildTextThread(ledger: Ledger): NonNullable<Scorecard['textThread']> {
  const pausedUntil = ledger.get('letters_paused_until');
  return { lettersPausedUntil: pausedUntil && pausedUntil.length ? pausedUntil : null, textsStopped: ledger.get('texts_stopped') === '1' };
}

/** Deferred by free-tier limits (E68): `integration_call` events logged `status: 'limited'` are figures
 * queued for the next day, never backfilled from another source class. */
function buildDeferred(ledger: Ledger): NonNullable<Scorecard['deferred']> {
  const integrations = new Set<string>();
  for (const e of ledger.events({ kind: 'integration_call' })) {
    const d = e.detail as { integration: string; status: string };
    if (d.status === 'limited') integrations.add(d.integration);
  }
  return { integrations: [...integrations], count: integrations.size };
}

const EMPTY_ACTIONS: Record<O1Criterion, string> = {
  1: 'enter a competition with stated selection criteria; an accelerator acceptance counts under #1 and #2',
  2: 'apply to a selective fellowship; an accelerator acceptance counts here too',
  3: 'pitch a trade publication or podcast; third-party coverage counts, your own posts do not',
  4: 'sign up to judge an award program or a hackathon now; certificates take about 3 months',
  5: 'document adoption by others: dependents, stars from other accounts, customer usage',
  6: 'a talk at a major conference counts (comparable evidence); submit a talk proposal',
  7: 'keep incorporation and governance documents; funding, an accelerator or press strengthens the organization',
  8: 'benchmark pay against the 90th percentile for the job code (BLS, CareerOneStop); equity and funding count',
};

const PRIORITY: O1Criterion[] = [6, 4, 3, 1, 2, 5, 7, 8];

function buildingAction(c: CandidateRow): string {
  const day = isoDay(c.event_date) ?? 'undated';
  switch (c.mapping.rule_id) {
    case 'C4-invite-unanswered':
      return `reply to the ${day} judge invite from ${c.issuer ?? 'the organizer'} ("${c.title}")`;
    case 'C4-awaiting-service':
      return `after judging "${c.title}", keep the thank-you or certificate from ${c.issuer ?? 'the organizer'}`;
    case 'C4-event-cancelled':
      return `"${c.title}" was cancelled; ask ${c.issuer ?? 'the organizer'} about the rescheduled date`;
    case 'X-future-pay':
      return 'the signed offer counts for EB-1A once the pay is earned';
    default:
      return `resolve "${c.title}" (${c.mapping.reason})`;
  }
}

export interface ScorecardContext {
  followers: number | null;
  degraded: string[];
  sharingWarnings: string[];
}

export function buildScorecard(ledger: Ledger, profile: FounderProfile, now: Date, ctx: ScorecardContext): Scorecard {
  const exhibits = ledger.exhibits();
  const candidates = ledger.candidates();
  const qualifying = exhibits.filter((e) => e.status === 'qualifying');
  const rows: CriterionRow[] = [];

  for (const o1 of [1, 2, 3, 4, 5, 6, 7, 8] as O1Criterion[]) {
    const eb1 = O1_TO_EB1[o1];
    const o1Ex = qualifying.filter((e) => e.criteria.includes(o1));
    const eb1Ex = exhibits.filter((e) => e.eb1a_status === 'qualifying' && e.eb1a_criteria.includes(eb1));
    const building = candidates.filter((c) => c.criteria.includes(o1) && (c.status === 'building' || c.status === 'needs_attorney'));
    const eb1Building = candidates.filter((c) => c.mapping.eb1a_criteria.includes(eb1) && (c.mapping.eb1a_status === 'building' || c.mapping.eb1a_status === 'needs_attorney'));
    const o1State: CellState = o1Ex.length ? 'met' : building.length ? 'building' : 'empty';
    const eb1State: CellState = eb1Ex.length ? 'met' : eb1Building.length ? 'building' : 'empty';
    let nextAction: string | null = null;
    const open = building.find((b) => b.mapping.rule_id.startsWith('C4-')) ?? building[0];
    if (open) nextAction = buildingAction(open);
    else if (o1State === 'empty') nextAction = EMPTY_ACTIONS[o1];
    else if (o1Ex.length === 1) nextAction = `a second exhibit strengthens #${o1} (currently one)`;
    rows.push({ o1, eb1, name: O1_NAMES[o1], o1State, eb1State, exhibits: o1Ex.map((e) => e.exhibit_id), building: building.map((b) => b.title), nextAction });
  }

  const eb1Only = (['vii', 'x'] as Eb1Criterion[]).map((criterion) => {
    const ex = exhibits.filter((e) => e.eb1a_status === 'qualifying' && e.eb1a_criteria.includes(criterion));
    return { criterion, state: (ex.length ? 'met' : 'empty') as CellState, exhibits: ex.map((e) => e.exhibit_id) };
  });

  const o1Met = rows.filter((r) => r.o1State === 'met').length;
  const eb1Met = rows.filter((r) => r.eb1State === 'met').length + eb1Only.filter((r) => r.state === 'met').length;

  const warnings = finalMeritsWarnings(qualifying, rows, ledger, profile);

  const letters = ledger.letters();
  const figures = ledger.figures();
  const gapFigures = figures.filter((f) => f.status === 'insufficient_sources' || f.status === 'conflicting');
  const target = profile.targetFilingDate;
  const monthsLeft = Math.round(daysBetween(target, now.toISOString()) / 30.4) * (Date.parse(target) >= now.getTime() ? 1 : -1);
  const notCounted: Record<string, number> = {};
  for (const c of candidates.filter((x) => x.status === 'rejected')) notCounted[c.mapping.rule_id] = (notCounted[c.mapping.rule_id] ?? 0) + 1;

  const signatures = buildSignatures(ledger);
  const heldLetters = letters.filter((l) => l.state === 'held');
  const evaluatedLetters = letters.filter((l) => l.ws_decision !== null).length;
  const holdReasonCounts = new Map<string, number>();
  for (const l of heldLetters) for (const r of l.ws_reasons) holdReasonCounts.set(r, (holdReasonCounts.get(r) ?? 0) + 1);
  const topHoldReasons = [...holdReasonCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([reason, count]) => ({ reason, count }));
  const lettersGapNote = buildLettersGap(letters, signatures);
  const signedIds = new Set(signatures.rows.filter((r) => r.status === 'signed').map((r) => r.letterId));
  const lettersNeedMore = letters.filter((l) => signedIds.has(l.letter_id)).length < 5 || letters.filter((l) => signedIds.has(l.letter_id) && l.relationship === 'independent').length < 1;

  const unmet = rows.filter((r) => r.o1State !== 'met');
  const closest = [...unmet].sort((a, b) => (a.o1State === 'building' ? 0 : 1) - (b.o1State === 'building' ? 0 : 1) || PRIORITY.indexOf(a.o1) - PRIORITY.indexOf(b.o1))[0];
  // Once every O-1A criterion has an exhibit and none is thin, letters are the closest remaining gap
  // (PRD 6.7): surface that instead of the generic "every criterion covered" message.
  const thinRow = rows.find((r) => r.exhibits.length === 1);
  const nextAction = closest
    ? `#${closest.o1} ${closest.name} is ${closest.o1State === 'building' ? 'one exhibit away' : 'empty'}: ${closest.nextAction}`
    : (thinRow?.nextAction ?? (lettersNeedMore ? lettersGapNote : 'every O-1A criterion has at least one exhibit; add second exhibits where a criterion has one'));

  return {
    generatedAt: now.toISOString(),
    rows,
    eb1Only,
    o1Met,
    eb1Met,
    nextAction,
    warnings,
    goTrigger: {
      criteriaMet: o1Met,
      thirdPartyPress: qualifying.filter((e) => e.criteria.includes(3) && !e.comparable_for.includes(3)).length,
      followers: ctx.followers,
    },
    gap: {
      targetFilingDate: target,
      monthsLeft,
      note: monthsLeft < 4 ? 'less than the 4 months of evidence gathering the EB-1 guide describes' : monthsLeft > 12 ? 'more than the 4 to 12 months of evidence gathering the guide describes' : 'inside the 4 to 12 months of evidence gathering the guide describes',
    },
    letters: {
      drafted: letters.length,
      heldCount: letters.filter((l) => l.state === 'held').length,
      awaitingApproval: letters.filter((l) => l.state === 'approval_requested').length,
      sent: letters.filter((l) => l.state === 'sent').length,
      dependent: letters.filter((l) => l.relationship === 'dependent').length,
      independent: letters.filter((l) => l.relationship === 'independent').length,
      holdReasons: letters.filter((l) => l.state === 'held').flatMap((l) => l.ws_reasons.slice(0, 1).map((r) => `${l.letter_id}: ${r}`)),
      evaluated: evaluatedLetters,
      holdRate: evaluatedLetters ? heldLetters.length / evaluatedLetters : null,
      topHoldReasons,
    },
    lettersGap: lettersGapNote,
    notCounted,
    figures: {
      pending: figures.filter((f) => f.status === 'pending').length,
      approved: figures.filter((f) => f.status === 'approved').length,
      denied: figures.filter((f) => f.status === 'denied').length,
      gaps: gapFigures.map((f) => `${f.exhibit_id} ${f.measure}: ${f.status} (${f.detail ?? ''})`),
    },
    sharingWarnings: ctx.sharingWarnings,
    degraded: ctx.degraded,
    signatures,
    translation: buildTranslation(ledger),
    tamperEvidence: buildTamperEvidence(ledger),
    discovery: buildDiscovery(ledger),
    textThread: buildTextThread(ledger),
    deferred: buildDeferred(ledger),
  };
}

function finalMeritsWarnings(qualifying: ExhibitRecord[], rows: CriterionRow[], ledger: Ledger, profile: FounderProfile): string[] {
  const warnings: string[] = [];
  const dates = qualifying.map((e) => e.event_date).filter((d): d is string => !!d).sort();
  if (dates.length >= 4) {
    let best = 0;
    for (let i = 0; i < dates.length; i++) {
      const inWindow = dates.filter((d) => Date.parse(d) >= Date.parse(dates[i]!) && daysBetween(d, dates[i]!) <= 31).length;
      best = Math.max(best, inWindow);
    }
    if (best / dates.length > 0.6) warnings.push(`Not sustained: ${best} of ${dates.length} qualifying exhibits fall inside one 31-day window.`);
  }
  const thin = rows.filter((r) => r.exhibits.length === 1).map((r) => `#${r.o1}`);
  if (thin.length) warnings.push(`Thin criteria (met by one exhibit only): ${thin.join(', ')}.`);
  // PRD 5.3 "no comparison to peers" plus the 6.11 figures table: every met criterion needs
  // approved context figures about the outlet, program, event or market it rests on.
  const approvedFor = (c: O1Criterion) => ledger.figures({ status: 'approved' }).some((f) => f.criterion === c);
  const PEER_FIGURE_LABEL: Record<O1Criterion, string> = {
    1: 'selection rate',
    2: 'acceptance rate',
    3: 'readership figures',
    4: 'submissions or participants figures',
    5: 'adoption figures',
    6: 'acceptance rate or impact measure',
    7: 'organizational-distinction figures',
    8: 'pay benchmark',
  };
  const noPeers: string[] = [];
  for (const r of rows) {
    if (r.o1State === 'met' && !approvedFor(r.o1)) noPeers.push(`#${r.o1} has no approved ${PEER_FIGURE_LABEL[r.o1]}`);
  }
  if (noPeers.length) warnings.push(`No comparison to peers: ${noPeers.join('; ')}.`);
  const self = qualifying.filter((e) => e.issuer && (e.issuer === profile.domain || e.issuer.endsWith(`.${profile.domain}`))).length;
  if (qualifying.length && self / qualifying.length > 0.5) warnings.push(`Self-sourced record: ${self} of ${qualifying.length} exhibits trace to the founder's own domain.`);
  return warnings;
}

const STATE_LABEL: Record<CellState, string> = { met: 'MET', building: 'building', empty: 'empty' };

export function renderScorecard(s: Scorecard, profile: FounderProfile): string {
  const lines = [
    `Exhibit scorecard for ${profile.name}`,
    `Generated ${s.generatedAt}. This says which working rules are met. It is not legal advice and it does not say anyone qualifies; an attorney decides.`,
    '',
    `O-1A: ${s.o1Met} of 8 criteria met (3 required).`,
    `EB-1A: ${s.eb1Met} of 10 criteria met (3 required).`,
    '',
    'Criterion | O-1A | EB-1A | Exhibits | Next action',
    '--- | --- | --- | --- | ---',
    ...s.rows.map((r) => `#${r.o1} ${r.name} (EB-1A ${r.eb1}) | ${STATE_LABEL[r.o1State]} | ${STATE_LABEL[r.eb1State]} | ${r.exhibits.join(', ') || '-'} | ${r.nextAction ?? '-'}`),
    ...s.eb1Only.map((r) => `EB-1A ${r.criterion} (no O-1A counterpart) | n/a | ${STATE_LABEL[r.state]} | ${r.exhibits.join(', ') || '-'} | -`),
    '',
    `Next action: ${s.nextAction}`,
    '',
    'GO-trigger view:',
    `- Criteria met: ${s.goTrigger.criteriaMet} (3 required; target 4 to 5)`,
    `- Third-party press: ${s.goTrigger.thirdPartyPress}`,
    `- Followers: ${s.goTrigger.followers ?? 'unknown'} (tracked, never an exhibit)`,
    '',
    `Target filing date ${s.gap.targetFilingDate}: ${s.gap.monthsLeft} months away, ${s.gap.note}.`,
    '',
    'Final-merits warnings for the attorney:',
    ...(s.warnings.length ? s.warnings.map((w) => `- ${w}`) : ['- none']),
    '',
    `Letters: ${s.letters.drafted} drafted, ${s.letters.awaitingApproval} awaiting your approval, ${s.letters.sent} sent, ${s.letters.heldCount} held (target 5 to 8; dependent ${s.letters.dependent}, independent ${s.letters.independent}).`,
    ...s.letters.holdReasons.map((r) => `- held ${r}`),
    s.lettersGap,
    ...(s.letters.evaluated
      ? [
          `Worth-sending: ${s.letters.evaluated} letter request(s) evaluated, ${s.letters.heldCount} held (hold rate ${s.letters.holdRate !== null ? `${Math.round(s.letters.holdRate * 100)}%` : 'n/a'}).`,
          ...(s.letters.topHoldReasons.length
            ? [`- top hold reasons: ${s.letters.topHoldReasons.map((r) => `${r.reason} (${r.count}x)`).join('; ')}`]
            : []),
        ]
      : []),
    '',
    `Context figures: ${s.figures.approved} approved, ${s.figures.pending} pending your review, ${s.figures.denied} denied.`,
    ...(s.figures.gaps.length ? ['Research gaps:', ...s.figures.gaps.map((g) => `- ${g}`)] : []),
    '',
    'Not counted, by reason:',
    ...(Object.keys(s.notCounted).length ? Object.entries(s.notCounted).sort().map(([k, v]) => `- ${k}: ${v}`) : ['- none']),
    ...(s.sharingWarnings.length ? ['', 'Sharing warnings (Exhibit never changes sharing):', ...s.sharingWarnings.map((w) => `- ${w}`)] : []),
    ...(s.degraded.length ? ['', `Degraded this run: ${s.degraded.join(', ')}`] : []),
    ...(s.signatures && s.signatures.rows.length
      ? [
          '',
          `Letters for signature: ${s.signatures.created} requested, ${s.signatures.signed} signed, ${s.signatures.declined} declined, ${s.signatures.expired} expired.`,
          ...s.signatures.rows
            .filter((r) => r.status === 'declined' || r.status === 'expired')
            .map((r) => `- ${r.letterId} (${r.signerEmail}) ${r.status}, returned to the scorecard: ${r.nextAction}`),
        ]
      : []),
    ...(s.translation && s.translation.needingTranslation
      ? [
          '',
          `Translation: ${s.translation.needingTranslation} item(s) need a certified translation, ${s.translation.draftsProduced} draft(s) produced, ${s.translation.waitingForOptIn} waiting for opt-in.`,
        ]
      : []),
    ...(s.tamperEvidence && s.tamperEvidence.stamped
      ? [
          '',
          `Tamper-evidence: ${s.tamperEvidence.stamped} artifact(s) stamped, ${s.tamperEvidence.confirmed} confirmed, ${s.tamperEvidence.pending} pending.`,
          ...(s.tamperEvidence.lastVerify
            ? [
                `- last verify: ${s.tamperEvidence.lastVerify.passed} of ${s.tamperEvidence.lastVerify.filesChecked} passed${
                  s.tamperEvidence.lastVerify.failed.length ? `, failed: ${s.tamperEvidence.lastVerify.failed.join(', ')}` : ''
                }`,
              ]
            : []),
        ]
      : []),
    ...(s.discovery && s.discovery.length
      ? [
          '',
          'Discovery this period:',
          ...s.discovery.map((d) => `- ${d.source}: ${d.found} found, ${d.rejected} rejected (second-identifier rule), ${d.merged} merged with an inbox item`),
        ]
      : []),
    ...(s.textThread && (s.textThread.lettersPausedUntil || s.textThread.textsStopped)
      ? [
          '',
          'Text thread:',
          ...(s.textThread.lettersPausedUntil ? [`- letter requests paused until ${s.textThread.lettersPausedUntil}`] : []),
          ...(s.textThread.textsStopped ? ['- texts stopped'] : []),
        ]
      : []),
    ...(s.deferred && s.deferred.count
      ? ['', `Deferred by free-tier limits: ${s.deferred.integrations.join(', ')} (queued for tomorrow).`]
      : []),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Writes the scorecard doc; returns null (never throws) when Google Docs is genuinely down, so the
 * ledger -- which stays authoritative regardless -- can still finish the run (PRD 10, section 11).
 */
export async function writeScorecard(docs: DocsApi, ledger: Ledger, text: string): Promise<string | null> {
  try {
    let id = ledger.get('scorecard_doc');
    if (!id) {
      id = (await docs.create('Exhibit scorecard')).documentId;
      ledger.set('scorecard_doc', id);
    }
    const current = await docs.getText(id);
    if (current !== text) await docs.replaceText(id, text);
    return id;
  } catch (err) {
    if (err instanceof TwinStubError || err instanceof TwinExpiredError) throw err;
    return null;
  }
}

/** Parse the headline counts back out of a scorecard, for the communication-failure check (constraint 11). */
export function parseScorecardCounts(text: string): { o1: number | null; eb1: number | null } {
  const o1 = text.match(/O-1A: (\d+) of 8/);
  const eb1 = text.match(/EB-1A: (\d+) of 10/);
  return { o1: o1 ? Number(o1[1]) : null, eb1: eb1 ? Number(eb1[1]) : null };
}
