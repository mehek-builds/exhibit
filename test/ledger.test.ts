import { describe, expect, it } from 'vitest';
import { Ledger } from '../src/ledger.js';
import type { CandidateRow, FigureRow, LetterRow } from '../src/ledger.js';
import { mapping as mkMapping } from '../src/rules/explicit.js';
import type { ExhibitRecord } from '../src/types.js';
import { NOW } from '../harness/corpus.js';

function exhibit(p: Partial<ExhibitRecord> & { exhibit_id: string; key: string; criteria: number[]; eb1a_criteria: string[] }): ExhibitRecord {
  return {
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

describe('ledger: exhibits CRUD round-trips', () => {
  it('insertExhibit then exhibit()/exhibitByKey() return the same record', () => {
    const ledger = new Ledger(':memory:');
    const rec = exhibit({ exhibit_id: 'EX-1-001', key: 'k1', criteria: [1], eb1a_criteria: ['i'] });
    ledger.insertExhibit(rec, 'r1', 'tr1');
    expect(ledger.exhibit('EX-1-001')).toEqual(rec);
    expect(ledger.exhibitByKey('k1')).toEqual(rec);
    expect(ledger.exhibits()).toEqual([rec]);
    ledger.close();
  });
});

describe('ledger: nextExhibitId produces a strictly increasing sequence', () => {
  it('increments per criterion prefix', () => {
    const ledger = new Ledger(':memory:');
    expect(ledger.nextExhibitId(1)).toBe('EX-1-001');
    ledger.insertExhibit(exhibit({ exhibit_id: 'EX-1-001', key: 'k1', criteria: [1], eb1a_criteria: ['i'] }), 'r1', null);
    expect(ledger.nextExhibitId(1)).toBe('EX-1-002');
    expect(ledger.nextExhibitId(4)).toBe('EX-4-001'); // independent sequence per criterion
    ledger.close();
  });
});

describe('ledger: supersede() hides the old row from exhibits() listing', () => {
  it('the superseded exhibit no longer appears in exhibits(), but does with includeSuperseded=true', () => {
    const ledger = new Ledger(':memory:');
    const v1 = exhibit({ exhibit_id: 'EX-1-001', key: 'k1', criteria: [1], eb1a_criteria: ['i'] });
    const v2 = exhibit({ exhibit_id: 'EX-1-001.v2', key: 'k1', criteria: [1], eb1a_criteria: ['i'], version: 2, supersedes: 'EX-1-001' });
    ledger.insertExhibit(v1, 'r1', null);
    ledger.insertExhibit(v2, 'r1', null);
    ledger.supersede('EX-1-001', 'EX-1-001.v2');
    const listed = ledger.exhibits();
    expect(listed.map((e) => e.exhibit_id)).toEqual(['EX-1-001.v2']);
    expect(ledger.exhibitByKey('k1')!.exhibit_id).toBe('EX-1-001.v2');
    const all = ledger.exhibits(true);
    expect(all.map((e) => e.exhibit_id).sort()).toEqual(['EX-1-001', 'EX-1-001.v2']);
    ledger.close();
  });
});

describe('ledger: candidates CRUD', () => {
  it('upsertCandidate then candidate()/candidates() round-trip, and a re-upsert updates in place', () => {
    const ledger = new Ledger(':memory:');
    const row: CandidateRow = {
      key: 'k1', status: 'building', eb1a_status: 'building', criteria: [4] as never,
      mapping: mkMapping([4] as never, 'building', 'C4-invite-unanswered', 'reason', 'quote'),
      title: 'Invite', issuer: 'x.example', event_date: '2026-01-01', url: null, sources: [], checks: [], exhibit_id: null, updated_run: 'r1',
    };
    ledger.upsertCandidate(row);
    expect(ledger.candidate('k1')).toEqual(row);

    const updated = { ...row, status: 'qualifying' as const, updated_run: 'r2' };
    ledger.upsertCandidate(updated);
    expect(ledger.candidate('k1')!.status).toBe('qualifying');
    expect(ledger.candidates()).toHaveLength(1);
    ledger.close();
  });
});

describe('ledger: figure-fingerprint lookup', () => {
  it('figureByFingerprint finds the most recently inserted figure for a fingerprint', () => {
    const ledger = new Ledger(':memory:');
    const fig = (id: string): FigureRow => ({
      fig_id: id, exhibit_id: 'EX-1-001', criterion: 1, measure: 'entrants', value: 100, unit: 'entrants', as_of: '2026-01-01',
      sources: [], label: null, note: '', status: 'pending', fingerprint: 'fp-1', detail: null, queued_at: null, decided_at: null, decision_reason: null, run_id: 'r1', trace_id: null,
    });
    ledger.insertFigure(fig('FIG-001'));
    expect(ledger.figureByFingerprint('fp-1')!.fig_id).toBe('FIG-001');
    expect(ledger.figureByFingerprint('does-not-exist')).toBeNull();
    ledger.close();
  });
});

describe('ledger: deny()/isDenied()', () => {
  it('a denied fingerprint is reported as denied; an unrelated one is not', () => {
    const ledger = new Ledger(':memory:');
    ledger.deny('fp-x', 'FIG-001', 'not a good source', NOW.toISOString());
    expect(ledger.isDenied('fp-x')).toBe(true);
    expect(ledger.isDenied('fp-y')).toBe(false);
    ledger.close();
  });
});

describe('ledger: events() filtering by kind and runId', () => {
  it('filters correctly across multiple kinds and runs', () => {
    const ledger = new Ledger(':memory:');
    ledger.event({ run_id: 'r1', trace_id: null, kind: 'letter_sent', detail: { a: 1 }, at: NOW.toISOString() });
    ledger.event({ run_id: 'r1', trace_id: null, kind: 'letter_held', detail: { b: 2 }, at: NOW.toISOString() });
    ledger.event({ run_id: 'r2', trace_id: null, kind: 'letter_sent', detail: { c: 3 }, at: NOW.toISOString() });

    expect(ledger.events({ kind: 'letter_sent' })).toHaveLength(2);
    expect(ledger.events({ runId: 'r1' })).toHaveLength(2);
    expect(ledger.events({ kind: 'letter_sent', runId: 'r1' })).toHaveLength(1);
    expect(ledger.events()).toHaveLength(3);
    ledger.close();
  });
});

describe('ledger: letters CRUD', () => {
  it('upsertLetter then letter()/letters() round-trip', () => {
    const ledger = new Ledger(':memory:');
    const row: LetterRow = {
      letter_id: 'LTR-priya', recommender_email: 'priya@buildnight.example', recommender_name: 'Priya Raman', relationship: 'independent',
      exhibit_ids: ['EX-4-001'], doc_id: null, state: 'drafted', ws_decision: null, ws_score: null, ws_reasons: [], approval_msg_id: null, sent_msg_id: null, updated_run: 'r1', trace_id: null,
    };
    ledger.upsertLetter(row);
    expect(ledger.letter('LTR-priya')).toEqual(row);
    expect(ledger.letters()).toHaveLength(1);
    ledger.close();
  });
});

describe('ledger: kv store, run lifecycle, and items', () => {
  it('get/set round-trip and run start/finish', () => {
    const ledger = new Ledger(':memory:');
    ledger.set('binder', JSON.stringify({ root: 'r1' }));
    expect(ledger.get('binder')).toBe(JSON.stringify({ root: 'r1' }));
    expect(ledger.get('missing')).toBeNull();

    ledger.startRun({ run_id: 'r1', scenario_id: null, attempt: null, release: 'dev', trace_id: null, started_at: NOW.toISOString(), mode: 'harness' });
    ledger.finishRun('r1', 'tr1', 'ok', NOW.toISOString());
    const runs = ledger.runs();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toBe('ok');
    ledger.close();
  });

  it('itemSeen / markItem tracks attempts and stage', () => {
    const ledger = new Ledger(':memory:');
    expect(ledger.itemSeen('gmail', 'm1')).toBeNull();
    ledger.markItem('gmail', 'm1', 'r1', 'retry');
    expect(ledger.itemSeen('gmail', 'm1')).toEqual({ stage: 'retry', attempts: 1 });
    ledger.markItem('gmail', 'm1', 'r1', 'done');
    expect(ledger.itemSeen('gmail', 'm1')).toEqual({ stage: 'done', attempts: 2 });
    ledger.close();
  });
});
