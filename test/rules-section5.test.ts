import { describe, expect, it } from 'vitest';
import { applyExplicitRules, enforceInvariants, mapping } from '../src/rules/explicit.js';
import { buildScorecard } from '../src/binder/scorecard.js';
import { Ledger } from '../src/ledger.js';
import { mapping as mkMapping } from '../src/rules/explicit.js';
import type { CandidateRow, FigureRow } from '../src/ledger.js';
import type { ExhibitRecord, Mapping } from '../src/types.js';
import { NOW } from '../harness/corpus.js';
import { cls, PROFILE, redacted } from './helpers.js';

// PRD 5.2 crosswalk exceptions, the T-revenue-not-pay bypass fix, and the 5.3 final-merits
// "no comparison to peers" warning (constraint 4: never file company revenue as personal pay).

describe('T-revenue-not-pay: the bypass sentence bug', () => {
  it('revenue plus an unrelated mention of stock/equity does NOT bypass the trap', () => {
    const it_ = redacted({
      app: 'gmail',
      id: 'm-revenue-bypass',
      title: 'Q2 update',
      text: 'Revenue was $2M this quarter. Separately, we don\'t offer stock options to early hires.',
    });
    const m = applyExplicitRules(it_, cls({ kind: 'remuneration' }), PROFILE);
    expect(m).not.toBeNull();
    expect(m!.rule_id).toBe('T-revenue-not-pay');
    expect(m!.status).toBe('rejected');
    expect(m!.eb1a_status).toBe('rejected');
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

describe('T-revenue-not-pay: structural personal-pay phrasings exempt the trap', () => {
  const cases: Array<[string, string]> = [
    ['salary with amount and revenue nearby', 'Salary: $210,000 per year. Company revenue was $4M ARR this quarter.'],
    ['base salary with amount', 'Revenue grew to $3M ARR. Base salary $210,000.'],
    ['annual compensation with amount', 'Annual compensation: $180k. Revenue was $2M this quarter.'],
    ['offer with amount and equity', 'Offer: $190,000 base plus 0.5% equity. Revenue was $2M this quarter.'],
    ['signed offer letter', 'We are pleased to extend this signed offer letter. Revenue was $2M this quarter.'],
    ['W-2', 'Attached is your W-2 for tax year 2025. Revenue was $2M this quarter.'],
    ['pay stub', 'Your pay stub for this period is attached. Revenue was $2M this quarter.'],
    ['equity grant to the person', 'You were issued an equity grant of 50,000 shares. Revenue was $2M this quarter.'],
  ];
  for (const [label, text] of cases) {
    it(`qualifies #8: ${label}`, () => {
      const it_ = redacted({ app: 'gmail', id: `m-pay-${label.replace(/\s+/g, '-')}`, title: 'Comp update', text });
      const m = applyExplicitRules(it_, cls({ kind: 'remuneration' }), PROFILE);
      expect(m?.rule_id).not.toBe('T-revenue-not-pay');
    });
  }

  const trapped: Array<[string, string]> = [
    ['negated stock options', "Revenue was $2M this quarter. We don't offer stock options to early hires."],
    ['stock market mention', 'Revenue was $2M this quarter. The stock market had a rough week.'],
    ['revenue per share', 'Revenue was $2M this quarter. Revenue per share was $0.40.'],
    ['no salary offered', 'Revenue was $2M this quarter. No salary is offered at this stage.'],
    ['generic offer, no amount', 'Revenue was $2M this quarter. We offer free onboarding to every customer.'],
    ['offer with a revenue amount', 'We offer annual plans; revenue was $2M this quarter.'],
  ];
  for (const [label, text] of trapped) {
    it(`still traps: ${label}`, () => {
      const it_ = redacted({ app: 'gmail', id: `m-trap-${label.replace(/\s+/g, '-')}`, title: 'Q2 update', text });
      const m = applyExplicitRules(it_, cls({ kind: 'remuneration' }), PROFILE);
      expect(m!.rule_id).toBe('T-revenue-not-pay');
      expect(m!.status).toBe('rejected');
    });
  }
});

describe('T-revenue-not-pay backstop in enforceInvariants', () => {
  it('a model mapping whose only #8 evidence is company revenue can never end up qualifying #8', () => {
    const it_ = redacted({
      app: 'gmail',
      id: 'm-revenue-backstop',
      title: 'Q2 update',
      text: 'Revenue was $2M this quarter. We don\'t offer stock options.',
    });
    const modelMapping: Mapping = mapping([8], 'qualifying', 'D-equity-comparable', 'model thought revenue was pay', 'Revenue was $2M this quarter.', { decided_by: 'model' });
    const out = enforceInvariants(modelMapping, it_, PROFILE);
    expect(out.criteria).not.toContain(8);
    expect(out.status).toBe('rejected');
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
