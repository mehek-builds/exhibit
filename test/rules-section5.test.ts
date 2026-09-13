import { describe, expect, it } from 'vitest';
import { applyExplicitRules, enforceInvariants, isPersonalPay, mapping, payEvidence, splitSentences } from '../src/rules/explicit.js';
import { buildScorecard } from '../src/binder/scorecard.js';
import { Ledger } from '../src/ledger.js';
import { mapping as mkMapping } from '../src/rules/explicit.js';
import type { CandidateRow, FigureRow } from '../src/ledger.js';
import type { ExhibitRecord, Mapping } from '../src/types.js';
import { DARA, NOW } from '../harness/corpus.js';
import { cls, PROFILE, redacted } from './helpers.js';

// PRD 5.2 crosswalk exceptions, the T-revenue-not-pay three-tier redesign, and the 5.3 final-merits
// "no comparison to peers" warning (constraint 4: never file company revenue as personal pay, and
// never silently reject genuine pay evidence either).
//
// T-revenue-not-pay now has three outcomes, driven by `payEvidence`:
//   strong    -> the trap does not fire at all (`applyExplicitRules` returns null for it)
//   ambiguous -> needs_attorney, rule_id 'T-revenue-not-pay', criteria kept as [8]
//   none      -> rejected, rule_id 'T-revenue-not-pay' (unchanged from before)
// Detection mistakes therefore degrade to "ask an attorney" rather than to either extreme.

describe('T-revenue-not-pay: the bypass sentence bug', () => {
  it('revenue plus an unrelated negated-stock mention is ambiguous, not a clean bypass', () => {
    // CHANGED from the old test: "stock" is ambiguous vocabulary (a generic mention, not a grant),
    // so per the new tier design this is no longer a clean 'rejected' -- it is 'needs_attorney'.
    // It still never becomes 'qualifying', which is the actual hard constraint.
    const it_ = redacted({
      app: 'gmail',
      id: 'm-revenue-bypass',
      title: 'Q2 update',
      text: 'Revenue was $2M this quarter. Separately, we don\'t offer stock options to early hires.',
    });
    const m = applyExplicitRules(it_, cls({ kind: 'remuneration' }), PROFILE);
    expect(m).not.toBeNull();
    expect(m!.rule_id).toBe('T-revenue-not-pay');
    expect(m!.status).toBe('needs_attorney');
    expect(m!.eb1a_status).toBe('needs_attorney');
    expect(m!.criteria).toEqual([8]);
  });

  it('still exempts a genuine personal-compensation statement tied to the founder', () => {
    const it_ = redacted({
      app: 'gmail',
      id: 'm-revenue-personal',
      title: 'Comp update',
      text: 'Revenue was $2M this quarter. Her salary was also increased to $220,000.',
    });
    const m = applyExplicitRules(it_, cls({ kind: 'remuneration' }), PROFILE);
    // T-revenue-not-pay must not fire; falls through to no explicit rule match here.
    expect(m?.rule_id).not.toBe('T-revenue-not-pay');
  });
});

describe('T-revenue-not-pay: structural personal-pay phrasings exempt the trap (strong tier)', () => {
  const cases: Array<[string, string]> = [
    ['salary with amount and revenue nearby', 'Salary: $210,000 per year. Company revenue was $4M ARR this quarter.'],
    ['base salary with amount', 'Revenue grew to $3M ARR. Base salary $210,000.'],
    ['offer with base and equity amount', 'Offer: $190,000 base plus 0.5% equity. Revenue was $2M this quarter.'],
    ['signed offer letter', 'We are pleased to extend this signed offer letter. Revenue was $2M this quarter.'],
    ['W-2', 'Attached is your W-2 for tax year 2025. Revenue was $2M this quarter.'],
    ['pay stub', 'Your pay stub for this period is attached. Revenue was $2M this quarter.'],
    // CHANGED: under the sentence-scoped design an equity/option grant needs a stated dollar
    // amount to be strong, same as any other pay term (constraint: 'strong' must be strict) --
    // a bare share count ("50,000 shares") isn't a quantified money amount on its own. The trap
    // still doesn't fire here (no revenue-adjacent business word in this sentence to fire it on),
    // but the tier itself is ambiguous, not strong; see the table below.
    // R1 under-match fixes: checks are sentence-scoped (splitSentences in src/rules/explicit.ts);
    // these cases pin that "Inc." doesn't split an offer from its amount and that a negation of a
    // different noun doesn't cancel the pay term.
    ['"Inc." between offer and amount', 'Offer from Loomwork Inc. $190,000 base plus 0.5% equity. Company ARR $3M.'],
    ['negation governs a different noun, not the pay term', 'No equity, just a base salary of $180,000. Loomwork ARR is $3M.'],
  ];
  for (const [label, text] of cases) {
    it(`qualifies #8 (strong, trap doesn't fire): ${label}`, () => {
      const it_ = redacted({ app: 'gmail', id: `m-pay-${label.replace(/\s+/g, '-')}`, title: 'Comp update', text });
      const m = applyExplicitRules(it_, cls({ kind: 'remuneration' }), PROFILE);
      expect(m?.rule_id).not.toBe('T-revenue-not-pay');
      expect(payEvidence(text)).toBe('strong');
    });
  }

  // Ambiguous pay-ish vocabulary alongside revenue: needs_attorney, not a clean reject or a clean pass.
  const ambiguous: Array<[string, string]> = [
    ['negated stock options', "Revenue was $2M this quarter. We don't offer stock options to early hires."],
    ['stock market mention', 'Revenue was $2M this quarter. The stock market had a rough week.'],
    ['revenue per share', 'Revenue was $2M this quarter. Revenue per share was $0.40.'],
    ['no salary offered', 'Revenue was $2M this quarter. No salary is offered at this stage.'],
    ['offer with a revenue amount', 'We offer annual plans; revenue was $2M this quarter.'],
    ['annual compensation with amount, no salary/base word', 'Annual compensation: $180k. Revenue was $2M this quarter.'],
  ];
  for (const [label, text] of ambiguous) {
    it(`needs_attorney (ambiguous): ${label}`, () => {
      const it_ = redacted({ app: 'gmail', id: `m-ambig-${label.replace(/\s+/g, '-')}`, title: 'Q2 update', text });
      const m = applyExplicitRules(it_, cls({ kind: 'remuneration' }), PROFILE);
      expect(m!.rule_id).toBe('T-revenue-not-pay');
      expect(m!.status).toBe('needs_attorney');
      expect(m!.criteria).toEqual([8]);
      expect(payEvidence(text)).toBe('ambiguous');
    });
  }

  // CHANGED: 'offer' (bare, any form) is now itself ambiguous pay vocabulary (payEvidence item 2:
  // the ambiguous tier is deliberately broad, F2's under-match fix), so "we offer free onboarding"
  // alongside revenue is no longer a clean reject -- it degrades to needs_attorney, the safe
  // direction (constraint 4). There is no remaining "no pay-ish vocabulary at all" case that still
  // contains the word "offer"; genuinely pay-vocabulary-free revenue text is covered by the
  // 'T-revenue-not-pay: the bypass sentence bug' and 'backstop' describe blocks below.
  const ambiguousOffer: Array<[string, string]> = [['generic offer, no amount', 'Revenue was $2M this quarter. We offer free onboarding to every customer.']];
  for (const [label, text] of ambiguousOffer) {
    it(`needs_attorney (ambiguous, bare "offer" vocabulary): ${label}`, () => {
      const it_ = redacted({ app: 'gmail', id: `m-trap-${label.replace(/\s+/g, '-')}`, title: 'Q2 update', text });
      const m = applyExplicitRules(it_, cls({ kind: 'remuneration' }), PROFILE);
      expect(m!.rule_id).toBe('T-revenue-not-pay');
      expect(m!.status).toBe('needs_attorney');
      expect(payEvidence(text)).toBe('ambiguous');
    });
  }
});

// Table-driven expectations for payEvidence / isPersonalPay (PRD 5.1 #8, 5.5 T-revenue-not-pay).
// Sentence-scoped: a pay term, a non-zero amount and no business-money or negation words must all
// sit in one sentence, and the splitter leaves decimals like "$1.5M" intact (R1, F1). `isPersonalPay`
// is a compatibility wrapper: true iff strong.
describe('payEvidence / isPersonalPay: table-driven expectation matrix', () => {
  const mustBeStrong: Array<[string, string]> = [
    ['salary with amount, revenue separate clause', 'Salary: $210,000 per year. Company revenue was $4M ARR this quarter.'],
    ['revenue clause then base salary clause', 'Revenue grew to $3M ARR. Base salary $210,000.'],
    ['offer with base and equity amount', 'Offer: $190,000 base plus 0.5% equity. Revenue was $2M this quarter.'],
    ['signed offer letter', 'signed offer letter'],
    ['W-2', 'W-2'],
    ['pay stub', 'pay stub'],
    // Regression cases from re-review N2: negation elsewhere on the line must not blank a real pay
    // statement in its own clause/sentence.
    ['negation in a later clause does not cancel an earlier salary clause', 'Salary: $210,000. We do not offer stock options at this stage. Revenue $4M ARR.'],
    ['negation in a middle clause does not cancel an offer-letter clause', 'Offer letter. Base salary $190,000, no equity. ARR $3M.'],
    // R1 fixes, verbatim from the review report.
    ['"Inc." never breaks a salary/amount pairing', 'Offer from Loomwork Inc. $190,000 base plus 0.5% equity. Company ARR $3M.'],
    ['negation on the wrong noun does not cancel the pay term', 'No equity, just a base salary of $180,000. Loomwork ARR is $3M.'],
    // Adversarial cases of our own.
    ['"U.S." abbreviation does not break matching', 'Base salary $190,000 for the U.S. team. Revenue was $2M this quarter.'],
    ['a $1.5M amount does not get split on its own decimal point', 'Base salary of $1.5M was agreed. Revenue was $2M this quarter.'],
    ['multiple unrelated sentences before the real pay clause', 'We closed a great quarter. Marketing spend was up. Legal signed off. Salary: $210,000.'],
  ];
  for (const [label, text] of mustBeStrong) {
    it(`is strong pay: ${label}`, () => {
      expect(payEvidence(text)).toBe('strong');
      expect(isPersonalPay(text)).toBe(true);
    });
  }

  const mustBeAmbiguous: Array<[string, string]> = [
    ['revenue clause, unrelated negated-equity clause', "Revenue was $2M this quarter. Separately, we don't offer stock options to early hires."],
    ['stock market mention', 'The stock market had a rough week.'],
    ['revenue per share', 'Revenue per share was $0.40.'],
    ['no salary offered', 'No salary is offered at this stage.'],
    ['offer with cadence but no amount, no compensation cue', 'We offer annual plans; revenue was $2M this quarter.'],
    // Regression cases from re-review N2/R1: over-exemption. Pay-shaped vocabulary that isn't a
    // strong salary/base-plus-amount or grant statement must degrade to needs_attorney, not exempt
    // the trap outright.
    ['compensation committee, not personal pay', 'Our compensation committee met; revenue was $4M ARR.'],
    ['offer aimed at customers with an amount', 'We offered customers a $99 plan; revenue grew to $2M.'],
    ['bare salary tied to ARR, no amount', 'Your salary is set based on our current ARR figures.'],
    ['equity offered without grant language', 'We offered her 0.5% equity as part of the package.'],
    ['annual compensation with amount but no salary/base word', 'Annual compensation: $180k. Revenue was $2M this quarter.'],
    // R1: over-exemption examples straight from the review report.
    ['bare "compensation management" product copy', 'We sell compensation management software to HR teams. ARR reached $5M.'],
    ['bare "Compensation expense" line item', 'Revenue: $4M. Compensation expense for the team: $1.2M.'],
    ['"offer SMBs a $49 plan per year", no salary/base word', 'Revenue $2M. We offer SMBs a $49 plan per year.'],
    // CHANGED: moved here from mustBeStrong. An equity/option grant needs a stated dollar amount
    // to be strong, same as any other pay term ('strong' must be strict) -- a bare share count
    // isn't a quantified money amount. Still genuine pay-ish vocabulary, so it's ambiguous, not none.
    ['equity grant issued to the person, no dollar amount', 'You were issued an equity grant of 50,000 shares.'],
    // CHANGED: moved here from mustBeNone. Bare "offered" is itself ambiguous vocabulary
    // (payEvidence item 2, F2's under-match fix); the amount is correctly not paired with it
    // (sentence-scoped), but the word alone still routes to needs_attorney, not a clean pass.
    ['amount far from the offer word, different sentence -- still ambiguous vocabulary', 'Revenue $2M. We offered a customer a partnership. Full pricing detail: the annual plan runs $10,000.'],
  ];
  for (const [label, text] of mustBeAmbiguous) {
    it(`is ambiguous: ${label}`, () => {
      expect(payEvidence(text)).toBe('ambiguous');
      expect(isPersonalPay(text)).toBe(false);
    });
  }

  const mustBeNone: Array<[string, string]> = [
    // CHANGED: 'offer' (any form) is now itself ambiguous vocabulary (F2's under-match fix), so a
    // "generic customer offer" is no longer pay-vocabulary-free; moved to mustBeAmbiguous above.
    ['a plain revenue statement with no pay vocabulary at all', 'Our ARR crossed $2M this quarter.'],
  ];
  for (const [label, text] of mustBeNone) {
    it(`is none: ${label}`, () => {
      expect(payEvidence(text)).toBe('none');
      expect(isPersonalPay(text)).toBe(false);
    });
  }

  // Adversarial cases of our own.
  describe('adversarial cases', () => {
    it('is ambiguous (not strong): revenue compensation from a business deal', () => {
      // Judgment call: bare "compensation" is always ambiguous under the new design (no more
      // committee/plan/revenue-compensation carve-outs -- those made the old regex fragile). A
      // detection mistake here degrades safely to needs_attorney rather than either extreme.
      expect(payEvidence('Revenue compensation from the partner deal was $1M.')).toBe('ambiguous');
    });

    it('is ambiguous: market salary benchmarks, surveys and data describe the field, not this person', () => {
      // A benchmark must never read as a strong personal-pay statement, even with a dollar amount
      // right next to the word "salary" (constraint 4).
      for (const s of ['Salary benchmarks for the market are $150k.', 'The 2026 salary survey puts the median at $140k.', 'Market salary for this role is $160k.', 'Compensation data for engineers: $150k median.']) {
        expect(payEvidence(s), s).toBe('ambiguous');
      }
      const it_ = redacted({ app: 'gmail', id: 'm-benchmark-revenue', title: 'Market note', text: 'Salary benchmarks for the market are $150k. Revenue was $2M this quarter.' });
      const m = applyExplicitRules(it_, cls({ kind: 'remuneration' }), PROFILE);
      expect(m!.rule_id).toBe('T-revenue-not-pay');
      expect(m!.status).toBe('needs_attorney');
    });

    it('is not pay: a customer-facing compensation plan mention (still ambiguous, not strong)', () => {
      expect(payEvidence('Our new compensation plan for customers launches next quarter.')).toBe('ambiguous');
      expect(isPersonalPay('Our new compensation plan for customers launches next quarter.')).toBe(false);
    });
  });
});

// Review round 4 (pay4.ts) findings F1 (over-exemption: revenue text read as strong) and F2
// (under-match: genuine pay without "salary"/"base" read as none). Every text below is verbatim
// from the review's evidence list.
describe('review round 4 F1: revenue text must never read as strong pay', () => {
  const revAsStrong: Array<[string, string]> = [
    ['negated salary, ARR nearby', "I haven't taken a salary, ARR is $2M."],
    ['zero salary, ARR nearby', 'Founder salary: $0, ARR hit $1.2M this quarter.'],
    ['salary costs (payroll), not personal pay', 'Salary costs were $800k; revenue $4M.'],
    ['salary budget for new hires', 'Q3: ARR $3M, salary budget for new hires $600k.'],
    ['salary TBD, no real amount', 'Salary: TBD, revenue $4M.'],
    ['market-average salary benchmark', 'Average salary in our market is $150k, and our revenue is $2M.'],
    ['employment agreement with someone else', 'We signed an employment agreement with our first hire. Revenue $2M.'],
    ['shares issued to investors, not the founder', 'We issued 1M shares to seed investors. Revenue $2M.'],
    ['payroll tool / pay stub as a product feature, not the founder’s own', 'Our payroll tool generates each pay stub. ARR $5M.'],
    ['explicitly negated salary via "without"', 'Without a salary, revenue funds me: $2M ARR.'],
    ['salary spend (payroll) cut, revenue rose', 'We cut salary spend by $200k while revenue rose to $3M.'],
    ['"Salary.com" brand name, not a pay statement', 'Salary.com lists revenue of $50M.'],
  ];
  for (const [label, text] of revAsStrong) {
    it(`is not strong: ${label}`, () => {
      expect(payEvidence(text), text).not.toBe('strong');
    });
  }

  it('none of the F1 texts let a model-qualifying #8 mapping survive enforceInvariants as qualifying', () => {
    for (const [, text] of revAsStrong) {
      const it_ = redacted({ app: 'gmail', id: `m-f1-${text.length}`, title: 'Update', text });
      const modelMapping: Mapping = mapping([8], 'qualifying', 'M-model', 'model', text, { decided_by: 'model' });
      const out = enforceInvariants(modelMapping, it_, PROFILE);
      expect(out.status, text).not.toBe('qualifying');
    }
  });
});

describe('review round 4 F2: genuine pay without "salary"/"base" must never read as none', () => {
  const payNone: Array<[string, string]> = [
    ['plain "pay" with amount', 'Your annual pay is $210,000. Company revenue last year: $4M.'],
    ['"cash comp" with amount', 'Total cash comp: $250,000/yr. ARR $3M.'],
    ['"wages paid" with amount', 'Wages paid to Dara Voss in 2025: $210,000. Revenue $4M.'],
    ['"gross pay" with amount', 'Your earnings statement: gross pay $17,500 this month. Revenue $4M.'],
    ['"will pay you" with amount', 'We will pay you $200,000 per year. Revenue $4M.'],
    ['1099-NEC paid amount', 'Form 1099-NEC: $180,000 paid to Dara Voss. Revenue $4M.'],
  ];
  for (const [label, text] of payNone) {
    it(`is not none (at least ambiguous): ${label}`, () => {
      expect(payEvidence(text), text).not.toBe('none');
    });
  }

  it('none of the F2 texts let a model-qualifying #8 mapping get silently rejected', () => {
    for (const [, text] of payNone) {
      const it_ = redacted({ app: 'gmail', id: `m-f2-${text.length}`, title: 'Update', text });
      const modelMapping: Mapping = mapping([8], 'qualifying', 'M-model', 'model', text, { decided_by: 'model' });
      const out = enforceInvariants(modelMapping, it_, PROFILE);
      expect(out.status, text).not.toBe('rejected');
    }
  });
});

describe('sentence-split boundary cases (own adversarial cases)', () => {
  it('period splits "Salary" from its amount into separate sentences -- judged ambiguous, not strong', () => {
    // "Salary." and "$210,000" land in different sentences once split on the period, so neither
    // sentence alone has both a pay term and a non-zero amount. This is a real loss of automation
    // versus a same-sentence "Salary: $210,000", but it is the safe direction (constraint 4): the
    // bare word "salary" is still pay-ish vocabulary, so the tier is ambiguous, never none.
    expect(payEvidence('Salary. $210,000')).toBe('ambiguous');
  });

  it('"Offer from Loomwork Inc. $190,000 base plus equity." is strong: "Inc." does not break the sentence', () => {
    // The decimal-aware splitter treats "Inc." as an ordinary sentence-ending period (no digits on
    // both sides), but "base plus equity" sits in the same clause as the amount either way because
    // there is no delimiter between "Inc." and "$190,000 base" other than the abbreviation period
    // itself -- "Offer from Loomwork Inc." and "$190,000 base plus equity." land in two sentences,
    // and the second sentence alone ("$190,000 base plus equity") has the base-amount pairing.
    expect(payEvidence('Offer from Loomwork Inc. $190,000 base plus equity.')).toBe('strong');
  });

  it('"Her salary is $0 while revenue is $2M." is not strong: the only amount for "salary" is zero', () => {
    expect(payEvidence('Her salary is $0 while revenue is $2M.')).not.toBe('strong');
    expect(payEvidence('Her salary is $0 while revenue is $2M.')).toBe('ambiguous');
  });

  it('"We pay our contractors $50/hr; revenue $1M." is ambiguous, not strong', () => {
    // Bare "pay" (no "paid you/her/him", "will pay you", "annual pay" or "pay of") is not a strong
    // PAY_TERM by design -- only the more specific forms are, precisely so that "we pay our
    // contractors" (someone else's pay) can't read as the founder's own. The semicolon also splits
    // this from "revenue $1M" into its own sentence, so the fallback is the broad ambiguous
    // vocabulary tier ("pay"), not none.
    expect(payEvidence('We pay our contractors $50/hr; revenue $1M.')).toBe('ambiguous');
  });

  it('"Base salary $180,000; company revenue $4M." is strong: the semicolon splits pay from revenue', () => {
    expect(payEvidence('Base salary $180,000; company revenue $4M.')).toBe('strong');
  });

  it('"Dara was granted 500,000 options." is ambiguous: a share/option count is not a dollar amount', () => {
    // The sentence names the founder as the grant recipient (equityGrantToPerson's leading-subject
    // heuristic matches "Dara was granted ..."), but a bare option count has no dollar amount, and
    // 'strong' requires one (same judgment call as the "equity grant issued to the person" case
    // above). Still genuine pay-ish vocabulary ("options"), so it is ambiguous, not none.
    expect(payEvidence('Dara was granted 500,000 options.', 'Dara Voss')).toBe('ambiguous');
    expect(payEvidence('Dara was granted 500,000 options.')).toBe('ambiguous');
  });
});

describe('T-revenue-not-pay backstop in enforceInvariants', () => {
  it('a model mapping whose only #8 evidence is company revenue (none tier) can never end up qualifying #8', () => {
    const it_ = redacted({
      app: 'gmail',
      id: 'm-revenue-backstop',
      title: 'Q2 update',
      text: 'Revenue was $2M this quarter.',
    });
    const modelMapping: Mapping = mapping([8], 'qualifying', 'D-equity-comparable', 'model thought revenue was pay', 'Revenue was $2M this quarter.', { decided_by: 'model' });
    const out = enforceInvariants(modelMapping, it_, PROFILE);
    expect(out.criteria).not.toContain(8);
    expect(out.status).toBe('rejected');
  });

  it('a model mapping with ambiguous pay evidence downgrades to needs_attorney, keeping the criteria', () => {
    const it_ = redacted({
      app: 'gmail',
      id: 'm-revenue-backstop-ambiguous',
      title: 'Q2 update',
      text: 'Revenue was $2M this quarter. We don\'t offer stock options.',
    });
    const modelMapping: Mapping = mapping([8], 'qualifying', 'D-equity-comparable', 'model thought revenue was pay', 'Revenue was $2M this quarter.', { decided_by: 'model' });
    const out = enforceInvariants(modelMapping, it_, PROFILE);
    expect(out.criteria).toContain(8); // kept, per the other invariants' downgrade pattern in this file
    expect(out.status).toBe('needs_attorney');
    expect(out.eb1a_status).toBe('needs_attorney');
  });

  it('does not drop #8 when the item carries a genuine structural pay statement alongside revenue', () => {
    const it_ = redacted({
      app: 'gmail',
      id: 'm-revenue-with-salary',
      title: 'Comp update',
      text: 'Base salary $210,000. Company revenue was $4M ARR this quarter.',
    });
    const modelMapping: Mapping = mapping([8], 'qualifying', 'D-equity-comparable', 'model reason', 'Base salary $210,000.', { decided_by: 'model' });
    const out = enforceInvariants(modelMapping, it_, PROFILE);
    expect(out.criteria).toContain(8);
  });

  it('does not drop #8 when the item also carries real funding/equity evidence', () => {
    const it_ = redacted({
      app: 'gmail',
      id: 'm-revenue-with-equity',
      title: 'Founder equity',
      text: 'Revenue was $2M this quarter. Dara received a Founder Stock Purchase Agreement for 8,000,000 shares.',
    });
    const modelMapping: Mapping = mapping([8], 'qualifying', 'D-equity-comparable', 'model reason', 'Founder Stock Purchase Agreement for 8,000,000 shares.', { decided_by: 'model' });
    const out = enforceInvariants(modelMapping, it_, PROFILE);
    expect(out.criteria).toContain(8);
  });
});

describe('S4 equity-grant must-count still qualifies', () => {
  it('a founder stock purchase agreement still counts toward #8 as comparable evidence', () => {
    const it_ = redacted({
      app: 'gmail',
      id: 'm-equity-must-count',
      title: 'Executed: Founder Stock Purchase Agreement',
      text: 'Dara Voss purchased 8,000,000 shares under the Founder Stock Purchase Agreement dated October 1, 2025.',
    });
    const m = applyExplicitRules(it_, cls({ kind: 'remuneration' }), PROFILE);
    expect(m!.rule_id).toBe('D-equity-comparable');
    expect(m!.criteria).toEqual([8]);
    expect(m!.status).toBe('qualifying');
  });
});

describe('PRD 5.2 crosswalk exceptions', () => {
  it('artistic/athletic original contributions of major significance: EB-1A (v) and O-1A both needs_attorney', () => {
    const it_ = redacted({
      app: 'gmail',
      id: 'm-artistic',
      title: 'Recognition',
      text: 'Critics described her athletic original contribution of major significance to the sport.',
    });
    const m = applyExplicitRules(it_, cls({ kind: 'other' }), PROFILE);
    expect(m).not.toBeNull();
    expect(m!.rule_id).toBe('X-artistic-athletic-eb1a-only');
    expect(m!.criteria).toEqual([]);
    expect(m!.status).toBe('needs_attorney');
    expect(m!.eb1a_criteria).toEqual(['v']);
    expect(m!.eb1a_status).toBe('needs_attorney');
  });

  it('commercial success in the performing arts: EB-1A (x) needs_attorney, no O-1A counterpart', () => {
    const it_ = redacted({
      app: 'gmail',
      id: 'm-performing-arts',
      title: 'Box office news',
      text: 'The tour was a commercial success in the performing arts, with record box office receipts.',
    });
    const m = applyExplicitRules(it_, cls({ kind: 'other' }), PROFILE);
    expect(m).not.toBeNull();
    expect(m!.rule_id).toBe('X-performing-arts-eb1a-only');
    expect(m!.criteria).toEqual([]);
    expect(m!.status).toBe('rejected');
    expect(m!.eb1a_criteria).toEqual(['x']);
    expect(m!.eb1a_status).toBe('needs_attorney');
  });
});

describe('X-exhibition-eb1a-only (previously untested)', () => {
  it('display at an art exhibition counts for EB-1A (vii) only; no O-1A counterpart', () => {
    const it_ = redacted({
      app: 'gmail',
      id: 'm-exhibition',
      title: 'Gallery show',
      text: 'Her sculpture was exhibited at the downtown gallery show last spring.',
    });
    const m = applyExplicitRules(it_, cls({ kind: 'other' }), PROFILE);
    expect(m).not.toBeNull();
    expect(m!.rule_id).toBe('X-exhibition-eb1a-only');
    expect(m!.criteria).toEqual([]);
    expect(m!.status).toBe('rejected');
    expect(m!.eb1a_criteria).toEqual(['vii']);
    expect(m!.eb1a_status).toBe('qualifying');
  });
});

// ---------------- final-merits "no comparison to peers" (5.3) ----------------

function exhibit(p: Partial<ExhibitRecord> & { exhibit_id: string; criteria: number[]; eb1a_criteria: string[] }): ExhibitRecord {
  return {
    key: p.exhibit_id,
    status: 'qualifying',
    eb1a_status: 'qualifying',
    comparable: false,
    comparable_for: [],
    rule_id: 'C1-award-competitive',
    metrics: {},
    title: 'An exhibit',
    issuer: 'launchfest.example',
    event_date: '2026-04-11',
    captured_at: NOW.toISOString(),
    sources: [],
    artifact_path: '01-awards/EX-1-001/',
    sha256: 'abc',
    reason: 'reason',
    version: 1,
    supersedes: null,
    people: [],
    ...p,
  } as ExhibitRecord;
}

function insertExhibit(ledger: Ledger, e: ExhibitRecord): void {
  ledger.insertExhibit(e, 'r1', null);
}

function insertCandidate(ledger: Ledger, c: Partial<CandidateRow> & { key: string; criteria: number[]; mapping: CandidateRow['mapping'] }): void {
  ledger.upsertCandidate({
    status: c.status ?? c.mapping.status,
    eb1a_status: c.eb1a_status ?? c.mapping.eb1a_status,
    title: c.title ?? 'A candidate',
    issuer: c.issuer ?? null,
    event_date: c.event_date ?? null,
    url: null,
    sources: [],
    checks: [],
    exhibit_id: c.exhibit_id ?? null,
    updated_run: 'r1',
    ...c,
  } as CandidateRow);
}

function figure(p: Partial<FigureRow> & { fig_id: string; exhibit_id: string; criterion: FigureRow['criterion'] }): FigureRow {
  return {
    measure: 'readership',
    value: 1000000,
    unit: 'monthly unique visitors',
    as_of: '2026-06-01',
    sources: [],
    label: 'independently_confirmed' as FigureRow['label'],
    note: 'note',
    status: 'approved',
    fingerprint: `fp-${p.fig_id}`,
    detail: null,
    queued_at: null,
    decided_at: NOW.toISOString(),
    decision_reason: null,
    run_id: 'r1',
    trace_id: null,
    ...p,
  } as FigureRow;
}

describe('final-merits: no comparison to peers covers every met criterion, not just #1 and #8', () => {
  it('flags a met #3 (published material) with no approved readership figure', () => {
    const ledger = new Ledger(':memory:');
    insertExhibit(ledger, exhibit({ exhibit_id: 'EX-3-001', criteria: [3], eb1a_criteria: ['iii'] }));
    insertCandidate(ledger, { key: 'k3', criteria: [3] as never, mapping: mkMapping([3] as never, 'qualifying', 'C3-major-outlet', 'r', 'q'), exhibit_id: 'EX-3-001' });
    const sc = buildScorecard(ledger, PROFILE, NOW, { followers: null, degraded: [], sharingWarnings: [] });
    const warning = sc.warnings.find((w) => w.startsWith('No comparison to peers'));
    expect(warning).toBeDefined();
    expect(warning).toContain('#3 has no approved readership figures');
  });

  it('does not flag #3 once an approved readership figure exists for it', () => {
    const ledger = new Ledger(':memory:');
    insertExhibit(ledger, exhibit({ exhibit_id: 'EX-3-001', criteria: [3], eb1a_criteria: ['iii'] }));
    insertCandidate(ledger, { key: 'k3', criteria: [3] as never, mapping: mkMapping([3] as never, 'qualifying', 'C3-major-outlet', 'r', 'q'), exhibit_id: 'EX-3-001' });
    ledger.insertFigure(figure({ fig_id: 'FIG-001', exhibit_id: 'EX-3-001', criterion: 3 as never, status: 'approved' }));
    const sc = buildScorecard(ledger, PROFILE, NOW, { followers: null, degraded: [], sharingWarnings: [] });
    const warning = sc.warnings.find((w) => w.startsWith('No comparison to peers'));
    expect(warning ?? '').not.toContain('#3');
  });
});

describe('payEvidence: a customer/user/install "base" next to revenue is never pay', () => {
  it('does not read a business base plus a revenue amount as strong pay', () => {
    for (const s of [
      'Our customer base grew and revenue reached $2M.',
      'Revenue was $3M across our install base this quarter.',
      'We expanded the user base; ARR hit $1.2M.',
      'Our revenue base of $2M carried the quarter.',
    ]) {
      expect(payEvidence(s), s).not.toBe('strong');
      const it_ = redacted({ app: 'gmail', id: `m-base-${s.length}`, title: 'Q3 update', text: s });
      expect(applyExplicitRules(it_, cls({ kind: 'remuneration' }), PROFILE)?.rule_id, s).toBe('T-revenue-not-pay');
    }
  });

  it('still reads "base" glued to an amount as strong pay', () => {
    for (const s of ['Offer from Loomwork Inc. $190,000 base plus equity.', '$190,000 base, 0.5% equity.', 'Base salary $180,000.', 'Your base of $175,000 starts in March.']) {
      expect(payEvidence(s), s).toBe('strong');
    }
  });
});

// Round-5 review (pay5.mts), G1 + G2: constraint 4 requires the FOUNDER's own pay, never someone
// else's contract or option pool next to revenue (G1, deterministic explicit-rule path), and
// never a strong quote fragment whose sentence never says whose pay it is (G2, model path). Every
// input below is verbatim from the review's evidence tables.
describe('G1: explicit #8 rules require a founder recipient, not just the pattern', () => {
  const neverQualifying: Array<[string, string]> = [
    ['employment agreement with a named third-party hire', 'We signed an employment agreement with our first hire; her start date is October 1. ARR hit $2M.'],
    ['consulting agreement with a named vendor', 'Investor update: our consulting agreement with Acme begins on May 1. MRR is $180k.'],
    ['option grant pool for employees', 'Q3 update: ARR $3M. We refreshed the option grant pool for new employees.'],
    ['equity grant plan for the sales team', 'Board approved the equity grant plan for the sales team. Revenue $5M.'],
  ];
  for (const [label, text] of neverQualifying) {
    it(`never files #8 qualifying: ${label}`, () => {
      const it_ = redacted({ app: 'gmail', id: `m-g1-${label.replace(/\s+/g, '-')}`, title: 'Update', text });
      const m = applyExplicitRules(it_, cls({ kind: 'remuneration' }), PROFILE);
      // Either the rule doesn't fire at all, or it fires but never as a qualifying #8.
      if (m) {
        expect(m.status, text).not.toBe('qualifying');
        expect(m.criteria.includes(8) && m.status === 'qualifying', text).toBe(false);
      }
    });
  }

  it('a bare "Employment agreement with our first hire" (no timing phrase) never qualifies', () => {
    const text = 'Employment agreement with our first hire';
    const it_ = redacted({ app: 'gmail', id: 'm-g1-bare-hire', title: 'Update', text });
    const m = applyExplicitRules(it_, cls({ kind: 'remuneration' }), PROFILE);
    expect(m?.status).not.toBe('qualifying');
  });

  it('D-funding-remuneration (SAFE, S3) still qualifies verbatim from harness/corpus.ts', () => {
    const text = 'Hi Dara,\n\nCongratulations on closing your round. The SAFE (simple agreement for future equity) for Loomwork, Inc. has closed with $750,000 from 6 investors at a $9M post-money valuation cap.\n\nView the closing documents in your dashboard.\n\nSafeHub';
    const it_ = redacted({ app: 'gmail', id: 'm-safe', title: 'Congratulations! Your SAFE financing has closed', text });
    const m = applyExplicitRules(it_, cls({ kind: 'remuneration' }), PROFILE);
    expect(m?.rule_id).toBe('D-funding-remuneration');
    expect(m?.status).toBe('qualifying');
    expect(m?.criteria).toEqual([8]);
  });

  it('D-equity-comparable (founder stock purchase agreement, S4) still qualifies verbatim from harness/corpus.ts', () => {
    const text = 'Dara Voss purchased 8,000,000 shares of common stock of Loomwork, Inc. under the Founder Stock Purchase Agreement dated October 1, 2025. The shares vest over four years.';
    const it_ = redacted({ app: 'gmail', id: 'm-equity', title: 'Executed: Founder Stock Purchase Agreement', text });
    const m = applyExplicitRules(it_, cls({ kind: 'remuneration' }), PROFILE);
    expect(m?.rule_id).toBe('D-equity-comparable');
    expect(m?.status).toBe('qualifying');
    expect(m?.criteria).toEqual([8]);
  });

  it('X-future-pay (signed offer letter, S16) still qualifies verbatim from harness/scenarios.ts', () => {
    const text = 'Dear Dara,\n\nWe are pleased to extend this offer letter for the role of Staff Engineer at Orbit Labs. You will be paid $310,000 base salary starting on January 4, 2027.\n\nOrbit Labs People Team';
    const it_ = redacted({ app: 'gmail', id: 'm-offer', title: 'Offer letter: Staff Engineer', text });
    const m = applyExplicitRules(it_, cls({ kind: 'remuneration' }), PROFILE);
    expect(m?.rule_id).toBe('X-future-pay');
    expect(m?.status).toBe('qualifying');
    expect(m?.criteria).toEqual([8]);
  });

  it('DARA.name is "Dara Voss", matching the recipient checks above', () => {
    expect(DARA.name).toBe('Dara Voss');
  });
});

describe('G2: strongPaySentence requires a founder recipient; the splitter respects abbreviations', () => {
  const neverStrong: Array<[string, string]> = [
    ['someone else\'s salary, same sentence as the amount', 'We hired our first engineer at a $150,000 salary.'],
    ['offer letter sent to a third party', 'We sent an offer letter to our first hire.'],
    ['W-2 forms for employees generally', 'Our accountant filed W-2 forms for all 12 employees.'],
    ["our first engineer's salary", "Our first engineer's salary is $150,000."],
  ];
  for (const [label, sentence] of neverStrong) {
    it(`is never strong: ${label}`, () => {
      expect(payEvidence(sentence), sentence).not.toBe('strong');
    });
  }

  it('"Your base salary will be $190,000" is strong', () => {
    expect(payEvidence('Your base salary will be $190,000.')).toBe('strong');
  });

  it('"Dara Voss will receive a salary of $180,000" is strong', () => {
    expect(payEvidence('Dara Voss will receive a salary of $180,000.')).toBe('strong');
  });

  it('"our first engineer\'s salary is $150,000" is never strong', () => {
    expect(payEvidence("our first engineer's salary is $150,000.")).not.toBe('strong');
  });

  it('"Employment agreement with our first hire" never qualifies #8', () => {
    const text = 'Employment agreement with our first hire';
    const it_ = redacted({ app: 'gmail', id: 'm-g2-bare-hire', title: 'Update', text });
    const m = applyExplicitRules(it_, cls({ kind: 'remuneration' }), PROFILE);
    expect(m?.status).not.toBe('qualifying');
  });

  it('"The U.S. offer letter sets your base salary at $190,000." is strong -- the splitter must not break on "U.S."', () => {
    const text = 'The U.S. offer letter sets your base salary at $190,000.';
    expect(splitSentences(text)).toEqual([text.replace(/\.$/, '')]);
    expect(payEvidence(text)).toBe('strong');
  });

  it('splitter does not split on "e.g." or "vs." either', () => {
    expect(splitSentences('Comp, e.g. salary, is discussed quarterly.')).toEqual(['Comp, e.g. salary, is discussed quarterly']);
    expect(splitSentences('Revenue was $2.5M vs. salary of $150k last yr.')).toEqual(['Revenue was $2.5M vs. salary of $150k last yr']);
  });

  it('a model quote of someone else\'s pay sentence never survives enforceInvariants as qualifying #8', () => {
    const cases: Array<[string, string]> = [
      ['We hired our first engineer at a $150,000 salary.\nARR is now $3M.', 'We hired our first engineer at a $150,000 salary.'],
      ['We sent an offer letter to our first hire.\nARR is $2M.', 'We sent an offer letter to our first hire.'],
      ['Our accountant filed W-2 forms for all 12 employees.\nARR $4M.', 'Our accountant filed W-2 forms for all 12 employees.'],
    ];
    for (const [text, quote] of cases) {
      const it_ = redacted({ app: 'gmail', id: `m-g2-${text.length}`, title: 'Update', text });
      const modelMapping: Mapping = mapping([8], 'qualifying', 'M-model', 'model', quote, { decided_by: 'model' });
      const out = enforceInvariants(modelMapping, it_, PROFILE);
      expect(out.status, text).not.toBe('qualifying');
    }
  });
});

describe('G2 residual: a model quote that names nobody cannot keep #8 when revenue is present', () => {
  it('downgrades an unattributed salary quote to needs_attorney, keeping the criterion', () => {
    for (const [text, quote] of [
      ['We compared offers vs. last year: salary of $150k last yr. ARR hit $2M.', 'salary of $150k last yr'],
      ['Base salary $210,000. Company revenue was $4M ARR this quarter.', 'Base salary $210,000.'],
    ] as const) {
      const it_ = redacted({ app: 'gmail', id: `m-g2r-${text.length}`, title: 'Update', text });
      const out = enforceInvariants(mapping([8], 'qualifying', 'M-model', 'model', quote, { decided_by: 'model' }), it_, PROFILE);
      expect(out.status, text).toBe('needs_attorney');
      expect(out.criteria, text).toContain(8);
    }
  });

  it('keeps #8 qualifying when the quote or its sentence names the founder', () => {
    const first = PROFILE.name.split(' ')[0]!;
    for (const [text, quote] of [
      ['Your base salary will be $190,000. Company ARR is $3M.', 'Your base salary will be $190,000.'],
      [`${first} will receive a salary of $180,000 per year. Revenue was $2M.`, 'salary of $180,000 per year'],
    ] as const) {
      const it_ = redacted({ app: 'gmail', id: `m-g2f-${text.length}`, title: 'Offer', text });
      const out = enforceInvariants(mapping([8], 'qualifying', 'M-model', 'model', quote, { decided_by: 'model' }), it_, PROFILE);
      expect(out.status, text).toBe('qualifying');
    }
  });
});

// pr-review-6 H1 (mapper.ts regression) and H2 (payRecipient scoping). One table drives:
//   - every pr-review-6 probe input (H1 and H2)
//   - every earlier G1/G2 input from scratchpad/review-pr5/pay5.mts
//   - the verbatim S3/S4/S16 corpus texts from harness/corpus.ts (must still qualify)
//   - the extra cases named in the fix brief
//
// `mapperOutcome` reproduces src/pipeline/mapper.ts's explicit-rule path exactly (H1: explicit
// mappings are returned as-is, never run through enforceInvariants).
describe('pr-review-6 H1/H2: explicit-rule mapping through the mapper.ts path (table-driven)', () => {
  function mapperOutcome(text: string, title = 'Update') {
    const it_ = redacted({ app: 'gmail', id: 'm-h', title, text });
    const explicit = applyExplicitRules(it_, cls({ kind: 'remuneration' }), PROFILE);
    // Mirrors mapper.ts: explicit mappings bypass enforceInvariants entirely (H1 fix).
    return explicit;
  }

  const QUALIFYING: Array<[string, string]> = [
    // H1: founder's own agreement next to revenue must qualify (the regression).
    ['H1: consulting agreement + revenue', 'Dear Dara, your consulting agreement with Acme begins on May 1. Acme revenue is $10M.'],
    ['H1: employment agreement + ARR', 'Dear Dara, attached is your employment agreement; your start date is January 4, 2027. Orbit Labs ARR is $40M.'],
    ['H1: name-form employment agreement + revenue', 'Dara Voss employment agreement: start date January 4, 2027. Orbit Labs revenue $40M.'],
    ['H1 control: same letter, no revenue sentence', 'Dear Dara, your consulting agreement with Acme begins on May 1.'],
    // S3/S4/S16 verbatim corpus texts
    ['S3 SAFE (verbatim)', 'Hi Dara,\n\nCongratulations on closing your round. The SAFE (simple agreement for future equity) for Loomwork, Inc. has closed with $750,000 from 6 investors at a $9M post-money valuation cap.\n\nView the closing documents in your dashboard.\n\nSafeHub'],
    ['S4 equity (verbatim)', 'Dara Voss purchased 8,000,000 shares of common stock of Loomwork, Inc. under the Founder Stock Purchase Agreement dated October 1, 2025. The shares vest over four years.'],
    ['S16 offer (verbatim)', 'Dear Dara,\n\nWe are pleased to extend this offer letter for the role of Staff Engineer at Orbit Labs. You will be paid $310,000 base salary starting on January 4, 2027.\n\nOrbit Labs People Team'],
  ];

  for (const [label, text] of QUALIFYING) {
    it(`qualifies #8: ${label}`, () => {
      const m = mapperOutcome(text);
      expect(m, text).not.toBeNull();
      expect(m!.status, text).toBe('qualifying');
      expect(m!.criteria, text).toContain(8);
    });
  }

  const NEVER_QUALIFYING: Array<[string, string]> = [
    // H2: third party wins over an incidental "you"/founder-name mention anywhere in the item.
    ['H2: thanks to you + sales-team grant + revenue', 'Thanks to all of you. Board approved the equity grant plan for the sales team. Revenue $5M.'],
    ['H2: for you our investors + option pool + ARR', 'Q3 update for you, our investors: ARR $3M. We refreshed the option grant pool for new employees.'],
    ['H2: Hi Dara + first hire employment agreement', 'Hi Dara, our first hire signed an employment agreement; her start date is October 1.'],
    ['other: your first hire\'s salary', "Your first hire's salary is $150,000."],
    ['other: you signed with our first engineer', 'You signed an agreement with our first engineer.'],
    // earlier G1 inputs from scratchpad/review-pr5/pay5.mts (must stay fixed, not regress)
    ['G1: employment agreement with named hire', 'We signed an employment agreement with our first hire; her start date is October 1. ARR hit $2M.'],
    ['G1: consulting agreement with vendor', 'Investor update: our consulting agreement with Acme begins on May 1. MRR is $180k.'],
    ['G1: option grant pool for employees', 'Q3 update: ARR $3M. We refreshed the option grant pool for new employees.'],
    ['G1: equity grant plan for sales team', 'Board approved the equity grant plan for the sales team. Revenue $5M.'],
  ];

  for (const [label, text] of NEVER_QUALIFYING) {
    it(`never qualifies #8: ${label}`, () => {
      const m = mapperOutcome(text);
      if (m) {
        expect(m.status === 'qualifying' && m.criteria.includes(8), text).toBe(false);
      }
    });
  }

  // G2 model-path inputs from pay5.mts: a strong-looking quote naming nobody but the founder must
  // still downgrade to needs_attorney when revenue is present and the quote/host names a third party.
  const MODEL_NEVER_QUALIFYING: Array<[string, string, string]> = [
    ['model: hire salary + ARR', 'We hired our first engineer at a $150,000 salary.\nARR is now $3M.', 'We hired our first engineer at a $150,000 salary.'],
    ['model: first hire salary quote', "Your first hire's salary is $150,000.\nARR is now $3M.", "Your first hire's salary is $150,000."],
    ['model: you approved for our first engineer', 'You approved a $150,000 salary for our first engineer.\nARR is now $3M.', 'You approved a $150,000 salary for our first engineer.'],
  ];
  for (const [label, text, quote] of MODEL_NEVER_QUALIFYING) {
    it(`model path never qualifies #8: ${label}`, () => {
      const it_ = redacted({ app: 'gmail', id: `m-h-model-${label.length}`, title: 'Update', text });
      const out = enforceInvariants(mapping([8], 'qualifying', 'M-model', 'model', quote, { decided_by: 'model' }), it_, PROFILE);
      expect(out.status === 'qualifying' && out.criteria.includes(8), text).toBe(false);
    });
  }

  // No explicit rule fires on bare "salary" text (no offer letter/employment agreement/equity/
  // funding vocabulary) -- these are strong personal pay via the model path, keeping #8 qualifying
  // through enforceInvariants because the quote itself is the founder's own pay (strongPaySentence
  // + payRecipient === 'founder').
  const MODEL_QUALIFYING: Array<[string, string]> = [
    ['strong: your base salary', 'Your base salary will be $190,000.'],
    ['strong: named founder salary', 'Dara Voss will receive a salary of $180,000.'],
  ];
  for (const [label, text] of MODEL_QUALIFYING) {
    it(`model path qualifies #8: ${label}`, () => {
      expect(applyExplicitRules(redacted({ app: 'gmail', id: `m-h-mq-${label.length}`, title: 'Update', text }), cls({ kind: 'remuneration' }), PROFILE), text).toBeNull();
      const it_ = redacted({ app: 'gmail', id: `m-h-mq2-${label.length}`, title: 'Update', text });
      const out = enforceInvariants(mapping([8], 'qualifying', 'M-model', 'model', text, { decided_by: 'model' }), it_, PROFILE);
      expect(out.status, text).toBe('qualifying');
      expect(out.criteria, text).toContain(8);
    });
  }
});

describe('J1: the board, investors or a "Staff" title near the founder\'s own grant never make it someone else\'s', () => {
  const S4 = 'Dara Voss purchased 8,000,000 shares of common stock of Loomwork, Inc. under the Founder Stock Purchase Agreement dated October 1, 2025. The shares vest over four years.';
  const run = (text: string) => applyExplicitRules(redacted({ app: 'gmail', id: `m-j1-${text.length}`, title: 'Update', text }), cls({ kind: 'remuneration' }), PROFILE);

  it('keeps the founder\'s own equity grant qualifying (must-count #8)', () => {
    for (const text of [
      `${S4} The grant was approved by the board.`,
      'Hi Dara, the board approved your option grant of 500,000 shares.',
      `${S4} Dara holds them alongside our investors.`,
      'Dara, your equity grant as Chief of Staff vests over four years.',
    ]) {
      const m = run(text);
      expect(m?.rule_id, text).toBe('D-equity-comparable');
      expect(m?.status, text).toBe('qualifying');
    }
  });

  it('still never qualifies a grant or contract that belongs to someone else', () => {
    for (const text of [
      'Thanks to all of you. Board approved the equity grant plan for the sales team. Revenue $5M.',
      'Q3 update for you, our investors: we created an option grant pool for new employees. ARR $2M.',
      'Hi Dara, our first hire signed an employment agreement; her start date is October 1. ARR hit $2M.',
      'Board approved the option grant pool for new employees.',
      'We approved equity grants for staff this quarter. ARR $2M.',
      // K1: the board, investors or a titled Chief of Staff as the grant's or contract's recipient.
      'Dara, you approved the equity grant for the Board.',
      'Dara, you approved the equity grant for the board members.',
      'Dara, you approved the equity grant for our investors.',
      'Hi Dara, you approved the option grant for our Chief of Staff.',
      'Hi Dara, you approved an equity grant for our Staff Engineer, Sam.',
      'Hi Dara, your signature is needed on the option grant for our new Chief of Staff.',
      'Dara, you signed an employment agreement with our new Chief of Staff; start date October 1.',
      'Dara, you signed an offer letter for our new Chief of Staff; start date October 1.',
    ]) {
      expect(run(text)?.status, text).not.toBe('qualifying');
    }
  });

  it('keeps the founder\'s own contract for her board seat qualifying', () => {
    const text = 'Dear Dara, your consulting agreement for your board seat at Acme begins on May 1.';
    expect(run(text)?.status, text).toBe('qualifying');
  });
});
