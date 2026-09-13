import type { Ledger } from '../ledger.js';
import type { FounderProfile } from '../types.js';

// worth-sending v0.1 packets for Exhibit's own proactive texts (PRD 6.8, 6.13). This is the
// rubric's natural fit: nudging a user about the next step. Every judgment cites an evidence id
// drawn straight from the ledger; a digest with nothing new must score honestly (never `send`).

export type NotifyKind = 'digest' | 'nudge' | 'first_scorecard' | 'backfill_done';

export interface SelfTextFacts {
  /** Pending review-queue figure count, when relevant (first-scorecard, digest). */
  pendingFigures?: number;
  /** Days since the last Sunday digest was actually sent; null when never sent. */
  daysSinceLastDigest?: number | null;
  /** Days until an invite's mentioned date or explicit reply deadline (nudge only). */
  replyDeadlineDays?: number | null;
  /** Whether anything changed since the last text of this kind (digest honesty check). */
  hasNews?: boolean;
}

export interface PacketDeps {
  ledger: Ledger;
  profile: FounderProfile;
  now: Date;
}

export function buildSelfTextPacket(kind: NotifyKind, body: string, facts: SelfTextFacts, deps: PacketDeps): Record<string, unknown> {
  const { profile, now } = deps;
  const evidence: { id: string; fact: string; source: string; observed_at: string; scope: 'individual'; kind: 'observed' | 'inference' }[] = [];
  let n = 0;
  const fact = (text: string, factKind: 'observed' | 'inference' = 'observed'): string => {
    n += 1;
    const id = `E-${n}`;
    evidence.push({ id, fact: text, source: 'Exhibit ledger', observed_at: now.toISOString(), scope: 'individual', kind: factKind });
    return id;
  };

  // Always at least one fact, so every judgment below (even a bare backfill notice) has a
  // non-empty evidence_ids list; worth-sending rejects a "known" judgment with none.
  const baseId = fact(`Exhibit's proactive notifier generated this "${kind}" message from the founder's own ledger state at ${now.toISOString()}.`);
  const pendingId = facts.pendingFigures !== undefined ? fact(`${facts.pendingFigures} figure(s) are pending the founder's review in the Exhibit review sheet.`) : null;
  const digestId = facts.daysSinceLastDigest != null ? fact(`${facts.daysSinceLastDigest} day(s) since the last digest text.`) : null;
  const deadlineId = facts.replyDeadlineDays != null ? fact(`The judge invite's date is ${facts.replyDeadlineDays} day(s) away and it is still unanswered.`, 'inference') : null;
  const newsId = facts.hasNews !== undefined ? fact(facts.hasNews ? 'Something changed in the binder since the last text of this kind.' : 'Nothing has changed in the binder since the last text of this kind.') : null;
  const evIds = evidence.map((e) => e.id);
  const isDigest = kind === 'digest';
  const actionNeeded = !isDigest || facts.hasNews === true;

  return {
    rubric_version: '0.1',
    message: body,
    evaluated_at: now.toISOString(),
    recipient_context: `${profile.name}, the founder. This is her own proactive text channel (PRD 6.13): Exhibit texting itself to her, never a third party.`,
    delivery_context: `Text to the founder's own verified number. Kind: ${kind}.`,
    product_context: `Exhibit proactive notification "${kind}" (PRD 4.1, 6.8). Nothing here asks anyone but the founder to act, and it never carries identity numbers or document contents.`,
    recipient_benefit: 'A timely nudge toward the next concrete step in her own evidence binder, without opening the dashboard.',
    business_outcome: "Keeps the founder's evidence file moving: pending reviews get decided, and time-sensitive invites get answered before they lapse.",
    evidence,
    assessment: {
      checks: {
        claims_supported: { status: 'pass', reason: 'Every number in the message is read directly from the ledger, never invented.', evidence_ids: evIds },
        recipient_eligible: { status: 'pass', reason: 'The founder is the sole recipient of her own proactive channel.', evidence_ids: [baseId] },
        action_still_needed: {
          status: actionNeeded ? 'pass' : 'fail',
          reason: actionNeeded ? 'There is a concrete pending item, a time-sensitive gap, or new information since the last text.' : 'Nothing new to report; a digest that repeats stale information should not send.',
          evidence_ids: [pendingId, newsId, deadlineId].filter((x): x is string => !!x).concat(baseId),
        },
        delivery_allowed: { status: 'pass', reason: "Texting the founder's own verified number is allowed outside quiet hours.", evidence_ids: [baseId] },
        contact_window_clear: digestId
          ? { status: (facts.daysSinceLastDigest ?? 0) >= 6 ? 'pass' : 'fail', reason: 'The weekly digest respects a 6-day minimum gap between sends.', evidence_ids: [digestId] }
          : { status: 'pass', reason: 'Not a recurring digest; no minimum-gap rule applies.', evidence_ids: [baseId] },
      },
      dimensions: {
        recipient_value: { rating: actionNeeded ? 3 : 1, reason: actionNeeded ? 'A concrete next step or new status is worth a text.' : 'Nothing changed; a text now would be noise.', evidence_ids: evIds },
        relevance: { rating: 4, reason: "The message is generated entirely from the founder's own binder state.", evidence_ids: evIds },
        timing: { rating: deadlineId ? 4 : 3, reason: deadlineId ? 'A reply deadline within 7 days makes immediate delivery appropriate.' : 'Regular cadence, sent outside quiet hours.', evidence_ids: deadlineId ? [deadlineId] : [baseId] },
        actionability: { rating: 4, reason: 'One clear next action or a plain status update, with a link or a ready reply command.', evidence_ids: evIds },
        business_fit: { rating: 2, reason: 'A favor to herself, not a product ask; the rubric was written for product-adoption messages (PRD 6.8 fit caveat), so this dimension is deliberately awkward here.', evidence_ids: [baseId] },
      },
      weakest_assumption: 'The founder wants this as a text rather than only reflected on the dashboard next time she opens it.',
      success_measure: 'The founder reads the text and, if it asks for anything, replies with a command or opens the linked sheet.',
    },
  };
}
