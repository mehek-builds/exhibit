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
} as const;

// ---------------- pay evidence (PRD 5.1 #8, 5.5 T-revenue-not-pay) ----------------
//
// Sentence-scoped, not character-window: every check below runs against one sentence at a time
// (see `splitSentences`), so an unrelated amount or business-money word in a different sentence
// can never taint a genuine pay statement, and a genuine pay statement can never leak strength
// into an adjacent revenue sentence. Splitting is punctuation-based but never breaks a decimal
// amount like "$1.5M" or "0.5%".

/** A dollar amount, e.g. "$210,000", "$190,000", "$1.5M", "$49", "$0". */
const MONEY_RE = /\$\s?\d[\d,]*(?:\.\d+)?\s?(?:k|K|m|M)?\b/g;

/** True when `sentence` contains a dollar amount that is not exactly zero. */
function hasNonZeroMoney(sentence: string): boolean {
  MONEY_RE.lastIndex = 0;
  for (let m = MONEY_RE.exec(sentence); m; m = MONEY_RE.exec(sentence)) {
    const n = Number(m[0].replace(/[$,\skKmM]/g, ''));
    if (n > 0) return true;
  }
  return false;
}

/**
 * A personal pay term (PRD 5.1 #8): salary, base pay/salary, a "$X base"/"base of $X" pairing,
 * annual pay, "pay of", "paid you/her/him", "will pay you", wages, "compensation of $X", W-2, pay
 * stub, offer letter or employment agreement. Equity/stock/option grants are handled separately
 * (`equityGrantToPerson`) because they additionally require a person recipient.
 */
const PAY_TERM =
  /\b(?:base\s+(?:pay|salary)|salary|annual\s+pay|pay\s+of|paid\s+(?:you|her|him)|will\s+pay\s+you|wages?|compensation\s+of\s*\$|w-?2|pay\s?stub|offer\s+letter|employment\s+agreement)\b/gi;

/** "$190,000 base" or "base of $190,000" -- bare "base" used as pay shorthand. */
const BASE_AMOUNT_RE = /\$\s?\d[\d,]*(?:\.\d+)?\s?(?:k|K|m|M)?\s+base\b|\bbase\s*(?::|of|=)\s*\$\s?\d/gi;

/** Doc-type pay terms that count as strong even without a stated amount (PRD 5.1 #8). */
const AMOUNT_EXEMPT_TERM = /\b(w-?2|pay\s?stub|offer\s+letter)\b/i;

/** Business-money words: any of these in the sentence rule out strong personal pay (constraint 4). */
const BUSINESS_MONEY_RE =
  /\b(revenue|ARR|MRR|sales|costs?|expenses?|budget|burn|payroll|investors?|raised|round|valuation|customers?|users?|market|benchmarks?|surveys?|median|average)\b/i;

/** A negation ("not", "never", "haven't", "without", "zero", "$0", ...) within 3 words before `index`. */
function isNegatedBefore(sentence: string, index: number): boolean {
  const before = sentence.slice(0, index);
  const negRe = /\b(?:not|never|no|haven'?t|hasn'?t|didn'?t|without|zero)\b|\$0\b/gi;
  let last: RegExpExecArray | null = null;
  for (let m = negRe.exec(before); m; m = negRe.exec(before)) last = m;
  if (!last) return false;
  const between = before.slice(last.index + last[0].length);
  if (/[,.;:\n]/.test(between)) return false;
  const words = between.trim().split(/\s+/).filter(Boolean);
  return words.length <= 3;
}

/**
 * True when an equity/stock/option grant in `sentence` is addressed to a person -- "you"/"her"/
 * "him"/"the founder", the founder's own name (if passed), or a leading "<Name> was granted ..."
 * subject -- rather than to investors, employees or customers in general. A grant to a business
 * recipient like "investors" is already excluded via `BUSINESS_MONEY_RE`; this only needs to keep
 * a bare "we issued stock to employees" out.
 */
function equityGrantToPerson(sentence: string, founderName?: string): boolean {
  if (!/\b(?:granted|issued|awarded)\b/i.test(sentence)) return false;
  if (!/\b(?:equity|stock|shares?|options?)\b/i.test(sentence)) return false;
  if (/\b(?:you|her|him|the founder)\b/i.test(sentence)) return true;
  if (founderName) {
    const first = founderName.trim().split(/\s+/)[0];
    if (first && new RegExp(`\\b${first}\\b`, 'i').test(sentence)) return true;
  }
  // "<Name> was granted/issued/awarded ..." -- the grantee is the sentence's own subject.
  if (/^[A-Z][a-zA-Z'.-]*\s+(?:was\s+|is\s+|has\s+been\s+)?(?:granted|issued|awarded)\b/.test(sentence.trim())) return true;
  return false;
}

/**
 * True when `sentence` is one sentence carrying strong, unambiguous evidence of the *founder's
 * own* pay: a personal pay term (or a person-addressed equity grant), a non-zero amount (or a
 * doc-type term that counts without one), no business-money words, and no governing negation.
 * Strict by design (constraint 4, R1): every one of these narrows the match, never widens it.
 */
export function strongPaySentence(sentence: string, founderName?: string): boolean {
  if (BUSINESS_MONEY_RE.test(sentence)) return false;

  const termMatches: RegExpExecArray[] = [];
  PAY_TERM.lastIndex = 0;
  for (let m = PAY_TERM.exec(sentence); m; m = PAY_TERM.exec(sentence)) termMatches.push(m);
  BASE_AMOUNT_RE.lastIndex = 0;
  const baseMatches: RegExpExecArray[] = [];
  for (let m = BASE_AMOUNT_RE.exec(sentence); m; m = BASE_AMOUNT_RE.exec(sentence)) baseMatches.push(m);

  const nonZero = hasNonZeroMoney(sentence);

  for (const m of termMatches) {
    if (isNegatedBefore(sentence, m.index)) continue;
    if (nonZero || AMOUNT_EXEMPT_TERM.test(m[0])) return true;
  }
  for (const m of baseMatches) {
    const baseAt = m.index + m[0].toLowerCase().indexOf('base');
    if (isNegatedBefore(sentence, baseAt)) continue;
    return true;
  }
  if (equityGrantToPerson(sentence, founderName) && nonZero) return true;

  return false;
}

/**
 * Splits `text` into sentences on `.`, `!`, `?`, `;` and newlines, but never inside a decimal
 * amount ("$1.5M", "0.5%") -- a `.` flanked by digits on both sides is not a sentence break.
 */
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\n' || c === '!' || c === '?' || c === ';') {
      sentences.push(text.slice(start, i));
      start = i + 1;
    } else if (c === '.') {
      const prev = text[i - 1];
      const next = text[i + 1];
      if (prev && /\d/.test(prev) && next && /\d/.test(next)) continue; // decimal point
      sentences.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (start < text.length) sentences.push(text.slice(start));
  return sentences.map((s) => s.trim()).filter(Boolean);
}

/** Broad pay-ish vocabulary for the 'ambiguous' tier -- deliberately wide (constraint 4: real pay must never fall through to 'none'). */
const AMBIGUOUS_PAY_RE =
  /\b(salary|base|pay|paid|wages?|earns?|earned|earning|earnings|income|compensation|comp|stipend|bonus|stock|equity|shares?|options?|offer(?:ed|s)?|w-?2|pay\s?stub|payroll|1099)\b/i;

export type PayEvidence = 'strong' | 'ambiguous' | 'none';

/**
 * Three-tier personal-pay detection (PRD 5.1 #8, 5.5 T-revenue-not-pay). Sentence-scoped so a
 * revenue figure or a "salary" mention in one sentence can never pair with an amount or vocabulary
 * word in another (R1/F1). Mistakes degrade safely: 'strong' is strict and never fires on business
 * money; 'ambiguous' is broad and routes to needs_attorney rather than silently rejecting real pay
 * (F2) or silently exempting the trap on revenue text (F1).
 *
 * strong: some sentence in the text is `strongPaySentence`.
 * ambiguous: no sentence is strong, but the text contains pay-ish vocabulary anywhere.
 * none: no pay-ish vocabulary at all.
 */
export function payEvidence(text: string, founderName?: string): PayEvidence {
  const sentences = splitSentences(text);
  if (sentences.some((s) => strongPaySentence(s, founderName))) return 'strong';
  if (AMBIGUOUS_PAY_RE.test(text)) return 'ambiguous';
  return 'none';
}

/** True when the text states genuine personal pay strongly enough to exempt T-revenue-not-pay entirely. Compatibility wrapper over `payEvidence`. */
export function isPersonalPay(text: string): boolean {
  return payEvidence(text) === 'strong';
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
    apply(item, cls, profile) {
      if (cls.kind !== 'remuneration') return null;
      const text = fullText(item);
      const q = quoteFor(text, PATTERNS.revenue);
      if (!q) return null;
      const evidence = payEvidence(text, profile.name);
      if (evidence === 'strong') return null; // trap doesn't fire; other rules and the model decide
      if (evidence === 'ambiguous') {
        return mapping(
          [8],
          'needs_attorney',
          'T-revenue-not-pay',
          'Revenue alongside an unclear pay mention; an attorney decides whether any of it is personal remuneration (5.1 #8).',
          q,
          { eb1a_status: 'needs_attorney' },
        );
      }
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
    out.criteria.includes(8) &&
    PATTERNS.revenue.test(text) &&
    !PATTERNS.funding.test(text) &&
    !PATTERNS.equity.test(text)
  ) {
    // Deliberately NOT excluded here: PATTERNS.futurePay ("offer letter"/"employment agreement"/
    // "consulting agreement"). Bare presence of that vocabulary is not proof the pay is the
    // founder's own (F1: "We signed an employment agreement with our first hire."); the
    // strongPaySentence/payEvidence checks below already give a genuine offer letter its full
    // amount-exempt strength, so this backstop does not need a separate bypass for it.
    // Check the model's own cited quote first -- the exact sentence it read as pay evidence. If
    // the quote itself isn't strong, the model may have cited the wrong sentence even though the
    // text elsewhere is genuinely strong; either way that is an attorney call, not a silent keep.
    const quoteStrong = strongPaySentence(out.quote, profile.name);
    if (!quoteStrong) {
      const evidence = payEvidence(text, profile.name);
      if (evidence === 'none') {
        drop(8, 'Company revenue alone is never personal remuneration (T-revenue-not-pay).');
      } else {
        // 'ambiguous', or 'strong' elsewhere in the text but not in the cited quote: keep the
        // criteria (as X-artistic-athletic-eb1a-only and similar invariants do) but downgrade the
        // status -- an attorney, not the model, decides whether the pay mention is real.
        out.status = 'needs_attorney';
        out.eb1a_status = 'needs_attorney';
        const why =
          evidence === 'strong'
            ? 'The cited quote is not itself strong personal-pay evidence, even though the text elsewhere is; an attorney should confirm (T-revenue-not-pay).'
            : 'Revenue alongside an unclear pay mention; an attorney decides whether any of it is personal remuneration (T-revenue-not-pay).';
        out.reason = `${out.reason} ${why}`.trim();
      }
    }
    // quoteStrong: keep #8 as-is.
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
