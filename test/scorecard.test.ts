import { describe, expect, it } from 'vitest';
import { buildScorecard, parseScorecardCounts, renderScorecard } from '../src/binder/scorecard.js';
import { Ledger } from '../src/ledger.js';
import { mapping as mkMapping } from '../src/rules/explicit.js';
import type { CandidateRow } from '../src/ledger.js';
import type { ExhibitRecord } from '../src/types.js';
import { NOW } from '../harness/corpus.js';
import { PROFILE } from './helpers.js';

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

describe('scorecard: counts computed from a hand-built ledger match expectations', () => {
  it('counts one qualifying exhibit under #1 and a building item under #4', () => {
    const ledger = new Ledger(':memory:');
    insertExhibit(ledger, exhibit({ exhibit_id: 'EX-1-001', criteria: [1], eb1a_criteria: ['i'] }));
    insertCandidate(ledger, { key: 'k1', criteria: [1] as never, mapping: mkMapping([1] as never, 'qualifying', 'C1-award-competitive', 'r', 'q'), exhibit_id: 'EX-1-001' });
    insertCandidate(ledger, { key: 'k4', criteria: [4] as never, mapping: mkMapping([4] as never, 'building', 'C4-invite-unanswered', 'r', 'q'), title: 'Judge invite' });

    const sc = buildScorecard(ledger, PROFILE, NOW, { followers: 100, degraded: [], sharingWarnings: [] });
    const row1 = sc.rows.find((r) => r.o1 === 1)!;
    const row4 = sc.rows.find((r) => r.o1 === 4)!;
    expect(row1.o1State).toBe('met');
    expect(row1.exhibits).toEqual(['EX-1-001']);
    expect(row4.o1State).toBe('building');
    expect(sc.o1Met).toBe(1);
    ledger.close();
  });
});

describe('scorecard: next action for an unanswered judging invite', () => {
  it('suggests replying to the invite when #4 is building on an unanswered invite', () => {
    const ledger = new Ledger(':memory:');
    insertCandidate(ledger, {
      key: 'k4', criteria: [4] as never,
      mapping: mkMapping([4] as never, 'building', 'C4-invite-unanswered', 'An invitation to judge with no reply.', 'quote'),
      title: 'Invitation to judge CodeCraft Hack', issuer: 'codecraft.example', event_date: '2026-08-30',
    });
    const sc = buildScorecard(ledger, PROFILE, NOW, { followers: null, degraded: [], sharingWarnings: [] });
    const row4 = sc.rows.find((r) => r.o1 === 4)!;
    expect(row4.nextAction).toContain('reply to the');
    expect(row4.nextAction).toContain('codecraft.example');
    ledger.close();
  });
});

describe('scorecard: criterion #6 with zero items produces an empty-state action, not a crash', () => {
  it('row 6 is empty with the EMPTY_ACTIONS suggestion, no throw', () => {
    const ledger = new Ledger(':memory:');
    expect(() => buildScorecard(ledger, PROFILE, NOW, { followers: null, degraded: [], sharingWarnings: [] })).not.toThrow();
    const sc = buildScorecard(ledger, PROFILE, NOW, { followers: null, degraded: [], sharingWarnings: [] });
    const row6 = sc.rows.find((r) => r.o1 === 6)!;
    expect(row6.o1State).toBe('empty');
    expect(row6.nextAction).toMatch(/major conference|talk proposal/i);
    ledger.close();
  });
});

describe('scorecard: final-merits "Not sustained" warning (E35)', () => {
  it('warns when most qualifying exhibits cluster within a single month', () => {
    const ledger = new Ledger(':memory:');
    const dates = ['2026-03-01', '2026-03-05', '2026-03-10', '2026-03-20', '2026-08-01'];
    dates.forEach((d, i) => {
      const id = `EX-${(i % 8) + 1}-00${i + 1}`;
      insertExhibit(ledger, exhibit({ exhibit_id: id, criteria: [(i % 8) + 1] as never, eb1a_criteria: ['i'], event_date: d }));
    });
    const sc = buildScorecard(ledger, PROFILE, NOW, { followers: null, degraded: [], sharingWarnings: [] });
    expect(sc.warnings.some((w) => w.startsWith('Not sustained'))).toBe(true);
    ledger.close();
  });

  it('does NOT warn when exhibits are spread across the year', () => {
    const ledger = new Ledger(':memory:');
    const dates = ['2025-10-01', '2026-01-01', '2026-04-01', '2026-07-01'];
    dates.forEach((d, i) => {
      const id = `EX-${i + 1}-001`;
      insertExhibit(ledger, exhibit({ exhibit_id: id, criteria: [i + 1] as never, eb1a_criteria: ['i'], event_date: d }));
    });
    const sc = buildScorecard(ledger, PROFILE, NOW, { followers: null, degraded: [], sharingWarnings: [] });
    expect(sc.warnings.some((w) => w.startsWith('Not sustained'))).toBe(false);
    ledger.close();
  });
});

describe('scorecard: thin criterion (only 1 exhibit) is flagged', () => {
  it('flags criterion #1 when it has exactly one exhibit', () => {
    const ledger = new Ledger(':memory:');
    insertExhibit(ledger, exhibit({ exhibit_id: 'EX-1-001', criteria: [1], eb1a_criteria: ['i'] }));
    const sc = buildScorecard(ledger, PROFILE, NOW, { followers: null, degraded: [], sharingWarnings: [] });
    expect(sc.warnings.some((w) => w.includes('Thin criteria') && w.includes('#1'))).toBe(true);
    ledger.close();
  });
});

describe('scorecard: all-self-sourced record is flagged', () => {
  it('flags when every qualifying exhibit traces to the founder\'s own domain', () => {
    const ledger = new Ledger(':memory:');
    insertExhibit(ledger, exhibit({ exhibit_id: 'EX-1-001', criteria: [1], eb1a_criteria: ['i'], issuer: PROFILE.domain }));
    insertExhibit(ledger, exhibit({ exhibit_id: 'EX-2-001', criteria: [2], eb1a_criteria: ['ii'], issuer: `press.${PROFILE.domain}` }));
    const sc = buildScorecard(ledger, PROFILE, NOW, { followers: null, degraded: [], sharingWarnings: [] });
    expect(sc.warnings.some((w) => w.startsWith('Self-sourced record'))).toBe(true);
    ledger.close();
  });
});

describe('renderScorecard never claims a legal determination', () => {
  it('the rendered text never contains the literal phrase "qualifies for"', () => {
    const ledger = new Ledger(':memory:');
    insertExhibit(ledger, exhibit({ exhibit_id: 'EX-1-001', criteria: [1], eb1a_criteria: ['i'] }));
    const sc = buildScorecard(ledger, PROFILE, NOW, { followers: 500, degraded: [], sharingWarnings: [] });
    const text = renderScorecard(sc, PROFILE);
    expect(text).not.toContain('qualifies for');
    ledger.close();
  });
});

describe('parseScorecardCounts round-trips renderScorecard output', () => {
  it('recovers the same O-1A/EB-1A counts that buildScorecard computed', () => {
    const ledger = new Ledger(':memory:');
    insertExhibit(ledger, exhibit({ exhibit_id: 'EX-1-001', criteria: [1], eb1a_criteria: ['i'] }));
    insertExhibit(ledger, exhibit({ exhibit_id: 'EX-2-001', criteria: [2], eb1a_criteria: ['ii'] }));
    insertExhibit(ledger, exhibit({ exhibit_id: 'EX-4-001', criteria: [4], eb1a_criteria: ['iv'] }));
    const sc = buildScorecard(ledger, PROFILE, NOW, { followers: null, degraded: [], sharingWarnings: [] });
    const text = renderScorecard(sc, PROFILE);
    const parsed = parseScorecardCounts(text);
    expect(parsed.o1).toBe(sc.o1Met);
    expect(parsed.eb1).toBe(sc.eb1Met);
    ledger.close();
  });
});
