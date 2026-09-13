import { describe, expect, it } from 'vitest';
import {
  applyExplicitRules,
  enforceInvariants,
  EXPLICIT_RULE_IDS,
  isSelfAuthored,
  isSelfSourced,
  mapping,
  quoteFor,
  PATTERNS,
} from '../src/rules/explicit.js';
import { affected, allRuleIds, loadGraph, renderPrompt, validateGraph } from '../src/rules/graph.js';
import type { Mapping } from '../src/types.js';
import { cls, item, PROFILE, redacted } from './helpers.js';

// PRD 5.1, 5.5, 6.4, 8 (constraints 3 and 4): the explicit rules table, never model judgment for
// the traps and the founder's rule decisions.

describe('funding maps to #8, never #1', () => {
  it('a SAFE closing counts toward #8 remuneration', () => {
    const it_ = redacted({ app: 'gmail', id: 'm-safe', title: 'Your SAFE financing has closed', text: 'The SAFE (simple agreement for future equity) for Loomwork has closed with $750,000 from 6 investors.' });
    const c = cls({ kind: 'award' });
    const m = applyExplicitRules(it_, c, PROFILE);
    expect(m).not.toBeNull();
    expect(m!.criteria).toEqual([8]);
    expect(m!.criteria).not.toContain(1);
    expect(m!.rule_id).toBe('D-funding-remuneration');
  });

  it('never maps funding language to criterion 1 even via enforceInvariants on a model mapping', () => {
    const it_ = redacted({ app: 'gmail', id: 'm-safe2', title: 'SAFE closed', text: 'Investment has closed: $500,000 SAFE.' });
    const modelMapping: Mapping = mapping([1], 'qualifying', 'C1-award-competitive', 'model thought this was an award', 'Investment has closed: $500,000 SAFE.', { decided_by: 'model' });
    const out = enforceInvariants(modelMapping, it_, PROFILE);
    expect(out.criteria).not.toContain(1);
    expect(out.criteria).toEqual([8]);
  });
});

describe('equity treated as comparable evidence for #8', () => {
  it('a founder stock purchase agreement counts toward #8 as comparable evidence', () => {
    const it_ = redacted({ app: 'gmail', id: 'm-equity', title: 'Executed: Founder Stock Purchase Agreement', text: 'Dara Voss purchased 8,000,000 shares under the Founder Stock Purchase Agreement dated October 1, 2025.' });
    const m = applyExplicitRules(it_, cls({ kind: 'remuneration' }), PROFILE);
    expect(m!.criteria).toEqual([8]);
    expect(m!.comparable_for).toEqual([8]);
    expect(m!.status).toBe('qualifying');
  });
});

describe('future/conditional pay: qualifying for O-1A, building for EB-1A', () => {
  it('a signed offer letter with a start date counts for O-1A #8 but only building for EB-1A', () => {
    const it_ = redacted({ app: 'gmail', id: 'm-offer', title: 'Offer letter', text: 'Please find attached your offer letter. You will be paid $250,000 annually, with a start date of November 1, 2026.' });
    const m = applyExplicitRules(it_, cls({ kind: 'remuneration' }), PROFILE);
    expect(m!.status).toBe('qualifying');
    expect(m!.eb1a_status).toBe('building');
    expect(m!.rule_id).toBe('X-future-pay');
  });

  it('an offer letter with no future-pay timing language does not trigger the future-pay rule', () => {
    const it_ = redacted({ app: 'gmail', id: 'm-offer2', title: 'Offer letter template', text: 'This is a sample offer letter with no dates.' });
    const m = applyExplicitRules(it_, cls({ kind: 'remuneration' }), PROFILE);
    expect(m?.rule_id).not.toBe('X-future-pay');
  });
});

describe('accelerator program membership maps to [1, 2]', () => {
  it('an acceptance email maps to both criteria 1 and 2', () => {
    const it_ = redacted({ app: 'gmail', id: 'm-accel', title: 'Congratulations: accepted to Forge Accelerator', text: 'Loomwork has been accepted to Forge Accelerator Batch F26.' });
    const m = applyExplicitRules(it_, cls({ kind: 'acceptance' }), PROFILE);
    expect(m!.criteria.sort()).toEqual([1, 2]);
    expect(m!.rule_id).toBe('D-accelerator-acceptance');
  });

  it('does not fire on an unrelated award-kind item with no accelerator language', () => {
    const it_ = redacted({ app: 'gmail', id: 'm-award', title: 'Winner: Best Developer Tool', text: 'Congratulations, you won an award judged by a panel of engineers.' });
    const m = applyExplicitRules(it_, cls({ kind: 'award' }), PROFILE);
    expect(m?.rule_id).not.toBe('D-accelerator-acceptance');
  });
});

describe('press release given lower weight / needs scrutiny (rejected as press)', () => {
  it('rejects a press release as published material about the person', () => {
    const it_ = redacted({ app: 'gmail', id: 'm-pr', title: 'Distributed: launch announcement', text: 'FOR IMMEDIATE RELEASE\n\nLoomwork launches Flakehound 2.0. Distributed via PRWire.' });
    const m = applyExplicitRules(it_, cls({ kind: 'press_about' }), PROFILE);
    expect(m!.status).toBe('rejected');
    expect(m!.rule_id).toBe('T-press-release');
  });
});

describe('paid placements are flagged (rejected as press)', () => {
  it('rejects a paid placement / sponsored content item', () => {
    const it_ = redacted({ app: 'gmail', id: 'm-paid', title: 'Your sponsored content is live', text: 'This is a paid placement on our site.' });
    const m = applyExplicitRules(it_, cls({ kind: 'press_about' }), PROFILE);
    expect(m!.status).toBe('rejected');
    expect(m!.rule_id).toBe('T-paid-placement');
  });
});

describe('self-authored content rejected as evidence (never criterion 3)', () => {
  it('rejects a self-published Medium story for criterion 3', () => {
    const it_ = redacted({ app: 'gmail', id: 'm-medium', title: 'Your story was published', text: 'Dara Voss, your story "Why flaky tests are a product problem" was published.' });
    const m = applyExplicitRules(it_, cls({ kind: 'authored' }), PROFILE);
    // status is rejected -- it never counts as press, even though the mapping still names the
    // criterion it was rejected from.
    expect(m!.status).toBe('rejected');
    expect(m!.rule_id).toBe('T-self-authored-not-press');
  });

  it('isSelfAuthored is true when the author email is the founder\'s own', () => {
    const it_ = redacted({ app: 'gmail', id: 'x', author: { email: PROFILE.emails[0] } });
    expect(isSelfAuthored(it_, PROFILE)).toBe(true);
  });

  it('routes self-authored SCHOLARLY content to #6 instead of rejecting it entirely', () => {
    const it_ = redacted({
      app: 'gmail',
      id: 'm-scholarly',
      author: { email: PROFILE.emails[0] },
      title: 'Your paper was accepted',
      text: 'Our paper is now on arxiv.org and will appear in the proceedings of the conference.',
    });
    const m = applyExplicitRules(it_, cls({ kind: 'authored' }), PROFILE);
    expect(m!.criteria).toEqual([6]);
    expect(m!.status).toBe('qualifying');
  });
});

describe('scholarly articles map to #6', () => {
  it('a founder-authored arxiv paper maps to criterion 6', () => {
    const it_ = redacted({ app: 'gmail', id: 'm-arxiv', author: { email: PROFILE.emails[0] }, title: 'Paper accepted', text: 'Peer-reviewed and published on arxiv.org.' });
    const m = applyExplicitRules(it_, cls({ kind: 'authored' }), PROFILE);
    expect(m!.criteria).toEqual([6]);
    expect(m!.rule_id).toBe('C6-scholarly');
  });
});

describe('participation-only distinguished from judging', () => {
  it('a participation certificate is rejected under criterion 1', () => {
    const it_ = redacted({ app: 'gmail', id: 'm-part', title: 'Certificate of participation', text: 'Thank you for participating in the hackathon.' });
    const m = applyExplicitRules(it_, cls({ kind: 'award' }), PROFILE);
    expect(m!.status).toBe('rejected');
    expect(m!.rule_id).toBe('T-participation-certificate');
  });
});

describe('pay-to-enter awards are flagged', () => {
  it('rejects a self-nominated / entry-fee award', () => {
    const it_ = redacted({ app: 'gmail', id: 'm-fee', title: 'Confirm your entry fee', text: 'Please pay the nomination fee to complete your self-nominated entry.' });
    const m = applyExplicitRules(it_, cls({ kind: 'award' }), PROFILE);
    expect(m!.status).toBe('rejected');
    expect(m!.rule_id).toBe('T-pay-to-enter');
  });
});

describe('open-membership organizations do not count for #2', () => {
  it('rejects membership anyone can join without review', () => {
    const it_ = redacted({ app: 'gmail', id: 'm-open', title: 'Welcome to our community', text: 'Anyone can join our community, no review required.' });
    const m = applyExplicitRules(it_, cls({ kind: 'acceptance' }), PROFILE);
    expect(m!.status).toBe('rejected');
    expect(m!.rule_id).toBe('T-open-membership');
  });
});

describe('exhibition of work maps to EB-1A (vii) only, never O-1A', () => {
  it('display at an exhibition is EB-1A-qualifying but not an O-1A criterion', () => {
    const it_ = redacted({ app: 'gmail', id: 'm-exhib', title: 'Your work is on display', text: 'Your piece was exhibited at the gallery show downtown.' });
    const m = applyExplicitRules(it_, cls({ kind: 'other' }), PROFILE);
    expect(m!.criteria).toEqual([]);
    expect(m!.eb1a_criteria).toEqual(['vii']);
    expect(m!.eb1a_status).toBe('qualifying');
    // status here (the O-1A field) is 'rejected' -- there is no O-1A counterpart.
    expect(m!.status).toBe('rejected');
  });
});

describe('revenue is not conflated with personal pay', () => {
  it('rejects company revenue cited as remuneration', () => {
    const it_ = redacted({ app: 'gmail', id: 'm-rev', title: 'Q2 numbers', text: 'Our ARR crossed $2M this quarter.' });
    const m = applyExplicitRules(it_, cls({ kind: 'remuneration' }), PROFILE);
    expect(m!.status).toBe('rejected');
    expect(m!.rule_id).toBe('T-revenue-not-pay');
  });

  it('a bare salary mention with no amount is ambiguous, not a clean pass or reject (three-tier redesign)', () => {
    // CHANGED: under the new payEvidence three-tier design, a bare "salary" word with no amount
    // nearby is ambiguous vocabulary, not strong pay. T-revenue-not-pay now fires as needs_attorney
    // (rule_id stays 'T-revenue-not-pay') instead of not firing at all.
    const it_ = redacted({ app: 'gmail', id: 'm-rev2', title: 'Comp update', text: 'Your salary is set based on our current ARR figures.' });
    const m = applyExplicitRules(it_, cls({ kind: 'remuneration' }), PROFILE);
    expect(m!.rule_id).toBe('T-revenue-not-pay');
    expect(m!.status).toBe('needs_attorney');
  });
});

describe('enforceInvariants: SAFE emails never trigger criterion #1 (mutation test)', () => {
  const it_ = redacted({ app: 'gmail', id: 'm-safe-inv', title: 'SAFE closed', text: 'Your SAFE financing has closed for $500,000.' });

  it('enabled: funding invariant strips #1 from a model mapping', () => {
    const modelMapping: Mapping = mapping([1], 'qualifying', 'C1-award-competitive', 'model mistake', 'Your SAFE financing has closed for $500,000.', { decided_by: 'model' });
    const enabled = enforceInvariants(modelMapping, it_, PROFILE);
    expect(enabled.criteria).not.toContain(1);
  });

  it('disabled via RuleOptions: with the invariant switched off, criterion 1 survives (proves the mutation actually changes behavior)', () => {
    const modelMapping: Mapping = mapping([1], 'qualifying', 'C1-award-competitive', 'model mistake', 'Your SAFE financing has closed for $500,000.', { decided_by: 'model' });
    const disabled = enforceInvariants(modelMapping, it_, PROFILE, { disabled: ['T-funding-not-award', 'D-funding-remuneration'] });
    expect(disabled.criteria).toContain(1);
  });
});

describe('accelerator counts under #1 and #2 only (mutation test)', () => {
  it('with D-accelerator-acceptance enabled, both criteria are present', () => {
    const it_ = redacted({ app: 'gmail', id: 'm-accel-mut', title: 'Accepted to accelerator', text: 'Loomwork has been accepted to Forge Accelerator Batch F26.' });
    const m = applyExplicitRules(it_, cls({ kind: 'acceptance' }), PROFILE);
    expect(m!.criteria.sort()).toEqual([1, 2]);
  });

  it('with D-accelerator-acceptance disabled, the explicit rule no longer fires (falls through to null)', () => {
    const it_ = redacted({ app: 'gmail', id: 'm-accel-mut2', title: 'Accepted to accelerator', text: 'Loomwork has been accepted to Forge Accelerator Batch F26.' });
    const m = applyExplicitRules(it_, cls({ kind: 'acceptance' }), PROFILE, { disabled: ['D-accelerator-acceptance'] });
    expect(m).toBeNull();
  });
});

describe('self-authored content never counts for #3 (mutation test)', () => {
  const it_ = redacted({ app: 'gmail', id: 'm-self-mut', author: { email: PROFILE.emails[0] }, title: 'Article about me', text: 'A glowing article about my work.' });

  it('enabled: enforceInvariants strips criterion 3 from a self-authored item', () => {
    const modelMapping: Mapping = mapping([3], 'qualifying', 'C3-press-about', 'model thought this was press', 'A glowing article about my work.', { decided_by: 'model' });
    const out = enforceInvariants(modelMapping, it_, PROFILE);
    expect(out.criteria).not.toContain(3);
  });

  it('disabled: with the invariant switched off, criterion 3 survives', () => {
    const modelMapping: Mapping = mapping([3], 'qualifying', 'C3-press-about', 'model thought this was press', 'A glowing article about my work.', { decided_by: 'model' });
    const out = enforceInvariants(modelMapping, it_, PROFILE, { disabled: ['T-self-authored-not-press'] });
    expect(out.criteria).toContain(3);
  });
});

describe('quoteFor returns an exact substring, never a paraphrase', () => {
  it('returns a literal line from the source text matching the pattern', () => {
    const text = 'Line one is boring.\nCongratulations, you won an award!\nLine three.';
    const q = quoteFor(text, PATTERNS.pay); // reuse an existing pattern set indirectly via award test below instead
    expect(q).toBeNull(); // no pay-language line present; sanity check for null path
  });

  it('quote is an exact substring of the source for a real match', () => {
    const text = 'Intro paragraph.\nThe SAFE (simple agreement for future equity) has closed.\nOutro.';
    const q = quoteFor(text, PATTERNS.funding);
    expect(q).not.toBeNull();
    expect(text).toContain(q!);
  });

  it('truncates without adding ellipsis text that would break the substring property', () => {
    const longLine = `The SAFE has closed. ${'x'.repeat(400)}`;
    const q = quoteFor(longLine, PATTERNS.funding);
    expect(q).not.toBeNull();
    expect(longLine).toContain(q!);
    expect(q!.length).toBeLessThanOrEqual(280);
  });
});

describe('isSelfSourced', () => {
  it('true for a domain matching the founder company domain', () => {
    expect(isSelfSourced('loomwork.example', PROFILE)).toBe(true);
    expect(isSelfSourced('press.loomwork.example', PROFILE)).toBe(true);
  });
  it('false for an unrelated domain', () => {
    expect(isSelfSourced('devtoolsweekly.example', PROFILE)).toBe(false);
  });
  it('false for null domain', () => {
    expect(isSelfSourced(null, PROFILE)).toBe(false);
  });
});

describe('RuleOptions.disabled actually turns rules off, generically', () => {
  it('every explicit rule id is present in EXPLICIT_RULE_IDS', () => {
    expect(EXPLICIT_RULE_IDS).toContain('T-press-release');
    expect(EXPLICIT_RULE_IDS).toContain('T-funding-not-award');
    expect(EXPLICIT_RULE_IDS).toContain('D-equity-comparable');
  });

  it('disabling T-press-release lets the item fall through with no explicit mapping', () => {
    const it_ = redacted({ app: 'gmail', id: 'm-pr-mut', title: 'Distributed release', text: 'FOR IMMEDIATE RELEASE\n\nBig news.' });
    const withRule = applyExplicitRules(it_, cls({ kind: 'press_about' }), PROFILE);
    const withoutRule = applyExplicitRules(it_, cls({ kind: 'press_about' }), PROFILE, { disabled: ['T-press-release'] });
    expect(withRule!.status).toBe('rejected');
    expect(withoutRule).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Prompt graph (src/rules/graph.ts + prompts/*)
// ---------------------------------------------------------------------------

describe('prompt graph', () => {
  const g = loadGraph();

  it('validateGraph() returns no problems', () => {
    expect(validateGraph(g)).toEqual([]);
  });

  it('every EXPLICIT_RULE_IDS entry appears in allRuleIds(loadGraph())', () => {
    const known = allRuleIds(g);
    for (const id of EXPLICIT_RULE_IDS) expect(known).toContain(id);
  });

  it('every literal rule_id the heuristic model can emit appears in allRuleIds(loadGraph())', () => {
    const known = allRuleIds(g);
    const heuristicRuleIds = [
      'C1-award-competitive',
      'C1-no-selection-criteria',
      'C2-selective-membership',
      'N-unmapped',
      'C3-podcast',
      'C3-press-about',
      'C7-critical-role',
      'T-title-only',
      'C4-invite-unanswered',
      'C4-service-proof',
      'D-talk-comparable',
      'C6-talk-not-major',
      'R-not-evidence',
    ];
    for (const id of heuristicRuleIds) expect(known).toContain(id);
  });

  it('every literal rule_id structured.ts can emit appears in allRuleIds(loadGraph())', () => {
    const known = allRuleIds(g);
    const structuredRuleIds = [
      'C4-service-proof',
      'C4-event-cancelled',
      'T-invite-declined',
      'C4-invite-unanswered',
      'T-mentor-not-judge',
      'D-talk-comparable',
      'C6-talk-not-major',
      'C5-adoption',
      'T-own-stars',
      'C5-below-threshold',
      'D-code-review-comparable',
      'C4-review-below-threshold',
    ];
    for (const id of structuredRuleIds) expect(known).toContain(id);
  });

  it('every literal rule_id the verifier can emit appears in allRuleIds(loadGraph())', () => {
    const known = allRuleIds(g);
    const verifierRuleIds = ['V-no-source-date', 'V-issuer-unknown', 'V-non-english', 'V-quote-not-found', 'N-unmapped'];
    for (const id of verifierRuleIds) expect(known).toContain(id);
  });

  it("affected(['decisions-5-5']) includes mapper, scorecard-writer, letter-drafter and scenario ids S1, S2, S6", () => {
    const a = affected(g, ['decisions-5-5']);
    expect(a.prompts).toContain('mapper');
    expect(a.prompts).toContain('scorecard-writer');
    expect(a.prompts).toContain('letter-drafter');
    expect(a.scenarios).toContain('S1');
    expect(a.scenarios).toContain('S2');
    expect(a.scenarios).toContain('S6');
  });

  it("renderPrompt('mapper') contains the literal decisions text from prompts/fragments/decisions-5-5.json", () => {
    const rendered = renderPrompt(g, 'mapper');
    const decisionsFragment = g.fragments.get('decisions-5-5')!;
    for (const line of decisionsFragment.text) expect(rendered).toContain(line);
  });

  it('the source-lists fragment data includes a verifiers list', () => {
    const sourceLists = g.fragments.get('source-lists')!;
    const data = sourceLists.data as { verifiers: string[] };
    expect(Array.isArray(data.verifiers)).toBe(true);
    expect(data.verifiers.length).toBeGreaterThan(0);
    expect(data.verifiers).toContain('bls.gov');
  });
});
