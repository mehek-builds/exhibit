import type { Classification, Eb1Criterion, FounderProfile, Mapping, O1Criterion, RedactedItem, Status } from '../types.js';
import { domainOf, hostMatches } from '../util.js';

// Traps and the 2026-09-13 rule decisions (PRD 5.5) are explicit code, never model judgment (6.4).
// Each rule id must exist in a fragment under prompts/fragments; test/rules.test.ts enforces it.

export const O1_TO_EB1: Record<O1Criterion, Eb1Criterion> = { 1: 'i', 2: 'ii', 3: 'iii', 4: 'iv', 5: 'v', 6: 'vi', 7: 'viii', 8: 'ix' };

export interface RuleOptions {
  /** Rule ids switched off. Used only by the mutation check (PRD 12.2). */
  disabled?: readonly string[];
}

export const PATTERNS = {
  funding:
    /\b(SAFE|simple agreement for future equity|note purchase agreement|convertible note|priced round|(?:pre-)?seed round|investment (?:has )?closed|wired? (?:the )?(?:investment|funds))\b/i,
  equity: /\b(stock purchase agreement|founder (?:stock|shares)|restricted stock (?:purchase|award)|equity grant|option grant)\b/i,
  futurePay: /\b(offer letter|employment agreement|consulting agreement)\b/i,
  futurePayTiming: /\b(will (?:be paid|receive|earn)|start(?:ing)? date|effective (?:on|from)|begins? on)\b/i,
  accelerator:
    /\b(?:accepted|admitted|selected|welcome)\b[^\n]{0,90}\b(?:accelerator|batch|cohort|Y Combinator)\b|\b(?:accelerator|batch)\b[^\n]{0,90}\b(?:accepted|admitted|selected)\b/i,
  pressRelease: /\b(FOR IMMEDIATE RELEASE|press release|distributed (?:by|via)|newswire)\b/i,
  paidPlacement: /\b(sponsored (?:content|post|placement)|paid placement|advertorial|promoted content)\b/i,
  authored: /\b(your (?:story|article|post|essay) (?:was|has been|is) (?:published|live|now live)|you published)\b/i,
  scholarly: /\b(doi\.org|proceedings of|peer[- ]reviewed|journal of|arxiv\.org)\b/i,
  participation: /\b(certificate of participation|thanks? (?:you )?for participating)\b/i,
  payToEnter: /\b(entry fee|nomination fee|self-nominat\w*|pay to (?:enter|apply))\b/i,
  openMembership: /\b(anyone can join|open to all|membership fee|join (?:our|the) community)\b/i,
  exhibition: /\b(exhibited at|on display at|gallery show|art (?:exhibition|showcase))\b/i,
  artisticAthleticContribution: /\b(artistic|athletic)\b[^\n]{0,90}\b(original contribution|contribution of major significance|major significance)\b|\b(original contribution|contribution of major significance)\b[^\n]{0,90}\b(artistic|athletic)\b/i,
  performingArtsSuccess: /\b(box office|ticket sales|gate receipts|record sales|streaming (?:numbers|figures))\b[^\n]{0,90}\b(commercial success|performing arts)\b|\b(commercial success)\b[^\n]{0,90}\b(performing arts|box office|ticket sales|record sales)\b/i,
  revenue: /\b(revenue|MRR|ARR|gross sales)\b/i,
  pay: /\b(salary|base pay|compensation|stock|equity|shares|SAFE|investment)\b/i,
  /**
   * A pay word that means personal pay on its own: salary, base pay/salary, compensation.
   * Excludes "compensation committee" and "compensation plan" (customer/product plans, board
   * committees -- not a person's pay), and "revenue compensation" ("compensation" used loosely
   * for business proceeds, e.g. "Revenue compensation from the partner deal"). Also excludes
   * market-level data ("salary benchmarks", "salary survey", "compensation data"): that is a
   * benchmark for the field, not this person's pay, and must never exempt the revenue trap.
   */
  payWordC: /\b(?<!revenue\s)(?<!market\s)(?:base\s+(?:pay|salary)|salary|compensation)\b(?!\s+(?:committee|plan|benchmarks?|surveys?|data|ranges?|bands?|percentiles?|reports?|trends?))/i,
  /** "offer"/"offered"/"offers", matched separately so we can check what governs it. */
  offerWord: /\boffer(?:ed|s)?\b/i,
  /** "offer" aimed at customers/users/clients is never personal pay, regardless of nearby amounts. */
  offerToCustomer: /\boffer(?:ed|s)?\b[^.;\n]{0,40}\b(?:customers?|users?|clients?)\b/i,
  /**
   * A compensation cue near "offer": salary/base wording, or a dollar amount tied to a role
   * ("Offer: $190,000 base"), or an annual-rate/equity-percent figure ("$190,000 per year",
   * "0.5% equity"). A bare "annual"/"per year" with no amount (e.g. "we offer annual plans") is
   * not enough -- that is a product-plan cadence, not compensation.
   */
  offerCompCue:
    /\boffer(?:ed|s)?\b[^.;\n]{0,40}(?:\bsalary\b|\bbase\b|\$\s?\d|\d+(?:\.\d+)?\s?%)|(?:\$\s?\d[\d,]*(?:\.\d+)?\s*(?:k|K|m|M)?|\d+(?:\.\d+)?\s?%)[^.;\n]{0,20}\b(?:per\s+year|annual(?:ly)?|yr)\b/i,
  /** Structural evidence of genuine personal compensation: an offer letter/contract, or a W-2/pay stub. */
  offerDocs: /\b(offer letter|employment (?:agreement|offer|contract)|signed offer|W-2|W2|pay ?stub)\b/i,
  /** Equity or stock actually granted/awarded/issued to a person, as distinct from a generic mention of "equity" or "stock". */
  equityGrant: /\b(equity grant|stock grant|option grant|(?:granted|awarded|issued|vesting)\b[^\n]{0,40}\b(?:shares|equity|stock options?|options)\b)\b/i,
  /** A negation word ("don't", "no", "never", ...), used to check whether it governs a nearby pay term. */
  negation: /\b(?:don'?t|does\s?n'?t|doesn'?t|do\s?n'?t|no|not|never|isn'?t|aren'?t)\b/i,
} as const;

/** Split text into clauses on sentence/clause boundaries, without breaking decimals like "$0.40". */
function splitClauses(text: string): string[] {
  return text
    .split(/\n|(?<!\d)[.!?](?!\d)|;/)
    .map((c) => c.trim())
    .filter(Boolean);
}

/** True when a negation word governs the term at `index` in `clause` (within the last few words before it). */
function isNegatedBefore(clause: string, index: number): boolean {
  const before = clause.slice(0, index).trim();
  const lastWords = before.split(/\s+/).slice(-5).join(' ');
  return PATTERNS.negation.test(lastWords);
}

/**
 * Whether a single clause states genuine personal pay: a pay word (salary/base/compensation) not
 * negated and not a committee/plan/revenue-compensation false friend, an "offer" with a real
 * compensation cue that isn't aimed at customers, an offer letter/contract/W-2/pay stub, or an
 * equity grant issued to a person. Judgment call: `equityGrant` doesn't separately exclude grants
 * offered to customers -- in practice "granted ... shares" to a non-person is not a phrasing we've
 * seen, so it's left unguarded rather than adding an untested exclusion.
 */
function clauseIsPersonalPay(clause: string): boolean {
  if (PATTERNS.offerDocs.test(clause)) return true;
  if (PATTERNS.equityGrant.test(clause)) return true;

  const payMatch = PATTERNS.payWordC.exec(clause);
  if (payMatch && !isNegatedBefore(clause, payMatch.index)) return true;

  if (PATTERNS.offerCompCue.test(clause) && !PATTERNS.offerToCustomer.test(clause)) {
    const offerMatch = PATTERNS.offerWord.exec(clause);
    if (offerMatch && !isNegatedBefore(clause, offerMatch.index)) return true;
  }

  return false;
}

/**
 * A genuine personal-compensation statement: an amount next to a pay word or "offer" (e.g. "Base
 * salary $210,000", "Offer: $190,000 base plus 0.5% equity"), an offer letter/contract/W-2/pay
 * stub, or an equity grant to the person. Structural cues, not pronouns, so it works whether the
 * text says "her salary" or "Salary: $210,000". Text is split into clauses (sentences, plus `;`)
 * and each is evaluated on its own, so a negation in one clause ("no equity") never cancels a pay
 * statement in another ("Base salary $190,000, no equity" -- still pay), while a negation next to
 * the pay term within the same clause does cancel it ("No salary is offered at this stage").
 */
export function isPersonalPay(text: string): boolean {
  return splitClauses(text).some(clauseIsPersonalPay);
}

function enabled(opts: RuleOptions | undefined, id: string): boolean {
  return !(opts?.disabled ?? []).includes(id);
}

/** An exact line of `text` around the first match, so the quote check (6.4) always holds. */
export function quoteFor(text: string, re: RegExp): string | null {
  const m = re.exec(text);
  if (!m || m.index === undefined) return null;
  const start = text.lastIndexOf('\n', m.index) + 1;
  const endIdx = text.indexOf('\n', m.index);
  const line = text.slice(start, endIdx < 0 ? text.length : endIdx);
  const trimmed = line.trim();
  return trimmed.length > 280 ? trimmed.slice(0, 280) : trimmed;
}

export function mapping(
  criteria: O1Criterion[],
  status: Status,
  rule_id: string,
  reason: string,
  quote: string,
  extra: Partial<Pick<Mapping, 'eb1a_status' | 'eb1a_criteria' | 'comparable_for' | 'decided_by'>> = {},
): Mapping {
  return {
    criteria,
    eb1a_criteria: extra.eb1a_criteria ?? criteria.map((c) => O1_TO_EB1[c]),
    status,
    eb1a_status: extra.eb1a_status ?? status,
    comparable_for: extra.comparable_for ?? [],
    rule_id,
    reason,
    quote,
    decided_by: extra.decided_by ?? 'rule',
  };
}

export function fullText(item: Pick<RedactedItem, 'title' | 'text'>): string {
  return `${item.title}\n${item.text}`;
}

export function isSelfAuthored(item: RedactedItem, profile: FounderProfile): boolean {
  const authorEmail = item.author?.email?.toLowerCase();
  if (authorEmail && profile.emails.map((e) => e.toLowerCase()).includes(authorEmail)) return true;
  if (item.app === 'linkedin' && item.meta.authorType === 'self') return true;
  return PATTERNS.authored.test(fullText(item));
}

interface ExplicitRule {
  id: string;
  /** Additional ids that the same code path implements (disabling any of them disables the rule). */
  alsoImplements?: string[];
  apply(item: RedactedItem, cls: Classification, profile: FounderProfile): Mapping | null;
}

const RULES: ExplicitRule[] = [
  {
    id: 'D-funding-remuneration',
    alsoImplements: ['T-funding-not-award'],
    apply(item, cls) {
      if (cls.kind === 'press_about' || cls.kind === 'authored') return null;
      const q = quoteFor(fullText(item), PATTERNS.funding);
      if (!q) return null;
      return mapping(
        [8],
        'qualifying',
        'D-funding-remuneration',
        'Venture funding never counts as an award (#1); it counts toward #8 remuneration (5.5).',
        q,
      );
    },
  },
  {
    id: 'D-equity-comparable',
    apply(item) {
      const q = quoteFor(fullText(item), PATTERNS.equity);
      if (!q) return null;
      return mapping([8], 'qualifying', 'D-equity-comparable', 'Founder equity in place of salary counts toward #8 as comparable evidence (5.5).', q, {
        comparable_for: [8],
      });
    },
  },
  {
    id: 'X-future-pay',
    apply(item) {
      const text = fullText(item);
      const q = quoteFor(text, PATTERNS.futurePay);
      if (!q || !PATTERNS.futurePayTiming.test(text)) return null;
      return mapping([8], 'qualifying', 'X-future-pay', 'A signed contract for future pay counts for O-1A #8 ("will command"); EB-1A needs pay already earned, so it counts once paid (5.2).', q, {
        eb1a_status: 'building',
      });
    },
  },
  {
    id: 'D-accelerator-acceptance',
    apply(item, cls) {
      if (cls.kind !== 'acceptance' && cls.kind !== 'award') return null;
      const q = quoteFor(fullText(item), PATTERNS.accelerator);
      if (!q) return null;
      return mapping([1, 2], 'qualifying', 'D-accelerator-acceptance', 'Accelerator acceptance counts under both #1 awards and #2 membership (5.5).', q);
    },
  },
  {
    id: 'T-press-release',
    apply(item) {
      const q = quoteFor(fullText(item), PATTERNS.pressRelease);
      if (!q) return null;
      return mapping([3], 'rejected', 'T-press-release', 'A press release is not published material about the person (#3).', q);
    },
  },
  {
    id: 'T-paid-placement',
    apply(item) {
      const q = quoteFor(fullText(item), PATTERNS.paidPlacement);
      if (!q) return null;
      return mapping([3], 'rejected', 'T-paid-placement', 'A paid placement is not published material about the person (#3).', q);
    },
  },
  {
    id: 'T-self-authored-not-press',
    apply(item, _cls, profile) {
      if (!isSelfAuthored(item, profile)) return null;
      const text = fullText(item);
      if (PATTERNS.scholarly.test(text)) {
        const q = quoteFor(text, PATTERNS.scholarly)!;
        return mapping([6], 'qualifying', 'C6-scholarly', 'Scholarly authorship counts under #6; it is never press about the person (#3).', q);
      }
      const q = quoteFor(text, PATTERNS.authored) ?? item.title;
      return mapping([3], 'rejected', 'T-self-authored-not-press', "The founder's own article or post is not published material about her (#3), and it is not scholarly (#6).", q);
    },
  },
  {
    id: 'T-participation-certificate',
    apply(item) {
      const q = quoteFor(fullText(item), PATTERNS.participation);
      if (!q) return null;
      return mapping([1], 'rejected', 'T-participation-certificate', 'A participation certificate is not a prize for excellence (#1).', q);
    },
  },
  {
    id: 'T-pay-to-enter',
    apply(item) {
      const q = quoteFor(fullText(item), PATTERNS.payToEnter);
      if (!q) return null;
      return mapping([1], 'rejected', 'T-pay-to-enter', 'Self-nominated or pay-to-enter recognition is not a competitive award (#1).', q);
    },
  },
  {
    id: 'T-open-membership',
    apply(item, cls) {
      if (cls.kind !== 'acceptance') return null;
      const q = quoteFor(fullText(item), PATTERNS.openMembership);
      if (!q) return null;
      return mapping([2], 'rejected', 'T-open-membership', 'Membership anyone can join without review does not require outstanding achievement (#2).', q);
    },
  },
  {
    id: 'X-exhibition-eb1a-only',
    apply(item) {
      const q = quoteFor(fullText(item), PATTERNS.exhibition);
      if (!q) return null;
      return mapping([], 'rejected', 'X-exhibition-eb1a-only', 'Display at an exhibition counts for EB-1A (vii) only; the O-1A has no counterpart (5.2).', q, {
        eb1a_criteria: ['vii'],
        eb1a_status: 'qualifying',
      });
    },
  },
  {
    id: 'X-artistic-athletic-eb1a-only',
    apply(item) {
      const q = quoteFor(fullText(item), PATTERNS.artisticAthleticContribution);
      if (!q) return null;
      return mapping([], 'needs_attorney', 'X-artistic-athletic-eb1a-only', 'Artistic or athletic original contributions count for EB-1A (v); the O-1A has no counterpart, so it needs the attorney (5.2).', q, {
        eb1a_criteria: ['v'],
        // "Major significance" is a judgment on the whole record, not a keyword; the attorney decides.
        eb1a_status: 'needs_attorney',
      });
    },
  },
  {
    id: 'X-performing-arts-eb1a-only',
    apply(item) {
      const q = quoteFor(fullText(item), PATTERNS.performingArtsSuccess);
      if (!q) return null;
      return mapping([], 'rejected', 'X-performing-arts-eb1a-only', 'Commercial success in the performing arts counts for EB-1A (x) only; the O-1A has no counterpart (5.2).', q, {
        eb1a_criteria: ['x'],
        // A mention of box office or sales is not proof of commercial success; the attorney decides.
        eb1a_status: 'needs_attorney',
      });
    },
  },
  {
    id: 'T-revenue-not-pay',
    apply(item, cls) {
      if (cls.kind !== 'remuneration') return null;
      const text = fullText(item);
      const q = quoteFor(text, PATTERNS.revenue);
      if (!q || isPersonalPay(text)) return null;
      return mapping([8], 'rejected', 'T-revenue-not-pay', 'Company revenue is not personal remuneration (#8).', q);
    },
  },
];

export const EXPLICIT_RULE_IDS: string[] = RULES.flatMap((r) => [r.id, ...(r.alsoImplements ?? [])]);

export function applyExplicitRules(item: RedactedItem, cls: Classification, profile: FounderProfile, opts?: RuleOptions): Mapping | null {
  for (const rule of RULES) {
    if (![rule.id, ...(rule.alsoImplements ?? [])].every((id) => enabled(opts, id))) continue;
    const hit = rule.apply(item, cls, profile);
    if (hit) return hit;
  }
  return null;
}

/**
 * Invariants applied to every model mapping (6.4): a model can never file funding as an award,
 * the founder's own writing as press, or split an accelerator acceptance.
 */
export function enforceInvariants(m: Mapping, item: RedactedItem, profile: FounderProfile, opts?: RuleOptions): Mapping {
  const text = fullText(item);
  let out: Mapping = { ...m, criteria: [...m.criteria], eb1a_criteria: [...m.eb1a_criteria] };
  const drop = (c: O1Criterion, why: string) => {
    if (!out.criteria.includes(c)) return;
    out.criteria = out.criteria.filter((x) => x !== c);
    out.eb1a_criteria = out.eb1a_criteria.filter((x) => x !== O1_TO_EB1[c]);
    out.reason = `${out.reason} ${why}`.trim();
  };
  if (enabled(opts, 'T-funding-not-award') && PATTERNS.funding.test(text)) {
    drop(1, 'Funding is never an award (T-funding-not-award).');
    if (out.criteria.length === 0 && enabled(opts, 'D-funding-remuneration')) {
      out = mapping([8], 'qualifying', 'D-funding-remuneration', 'Funding counts toward #8 remuneration (5.5).', quoteFor(text, PATTERNS.funding)!);
    }
  }
  if (enabled(opts, 'T-self-authored-not-press') && isSelfAuthored(item, profile)) {
    drop(3, "The founder's own writing is never press about her (T-self-authored-not-press).");
  }
  if (
    enabled(opts, 'T-revenue-not-pay') &&
    PATTERNS.revenue.test(text) &&
    !isPersonalPay(text) &&
    !PATTERNS.funding.test(text) &&
    !PATTERNS.equity.test(text) &&
    !PATTERNS.futurePay.test(text)
  ) {
    drop(8, 'Company revenue alone is never personal remuneration (T-revenue-not-pay).');
  }
  if (out.criteria.length === 0 && out.eb1a_criteria.length === 0 && out.status !== 'rejected') {
    out.status = 'rejected';
    out.eb1a_status = 'rejected';
  }
  return out;
}

/** True when an item comes from the founder's own company domain (5.3 self-sourced warning). */
export function isSelfSourced(domain: string | null, profile: FounderProfile): boolean {
  return !!domain && hostMatches(domain, profile.domain);
}

export { domainOf };
