import { describe, expect, it } from 'vitest';
import { buildScorecard, renderScorecard } from '../src/binder/scorecard.js';
import { processLetters } from '../src/letters/letters.js';
import type { LetterDeps } from '../src/letters/letters.js';
import { LibraryWorthSendingGate } from '../src/letters/worthSending.js';
import { Ledger } from '../src/ledger.js';
import type { LetterRow } from '../src/ledger.js';
import { LocalTracer } from '../src/observability/tracer.js';
import type { ExhibitRecord, FounderProfile } from '../src/types.js';
import { NOW, seed } from '../harness/corpus.js';
import { MemoryTwins } from '../src/twins/memory.js';
import { PROFILE } from './helpers.js';

// Tasks 1-3 (PRD 6.7, 6.8): the scorecard's letters gap note, the missing "one exhibit from met"
// letter trigger, and the worth-sending hold-rate / top-reasons reporting.

function baseExhibit(p: Partial<ExhibitRecord> & { exhibit_id: string; people: ExhibitRecord['people'] }): ExhibitRecord {
  return {
    key: p.exhibit_id,
    criteria: [4],
    eb1a_criteria: ['iv'],
    status: 'qualifying',
    eb1a_status: 'qualifying',
    comparable: false,
    comparable_for: [],
    rule_id: 'C4-service-proof',
    metrics: {},
    title: 'Judge, Spring Build Night',
    issuer: 'buildnight.example',
    event_date: '2026-03-14',
    captured_at: NOW.toISOString(),
    sources: [],
    artifact_path: '04-judging/EX-4-001/',
    sha256: 'abc',
    reason: 'reason',
    version: 1,
    supersedes: null,
    ...p,
  } as ExhibitRecord;
}

function baseLetter(p: Partial<LetterRow> & { letter_id: string }): LetterRow {
  return {
    recommender_email: 'r@example.test',
    recommender_name: 'Someone',
    relationship: 'dependent',
    exhibit_ids: [],
    doc_id: null,
    state: 'drafted',
    ws_decision: null,
    ws_score: null,
    ws_reasons: [],
    approval_msg_id: null,
    sent_msg_id: null,
    updated_run: 'r1',
    trace_id: null,
    ...p,
  };
}

describe('scorecard: letters gap note (PRD 6.7)', () => {
  it('reports how many more letters are needed, including the independent-expert shortfall, when nothing is signed yet', () => {
    const ledger = new Ledger(':memory:');
    const sc = buildScorecard(ledger, PROFILE, NOW, { followers: null, degraded: [], sharingWarnings: [] });
    expect(sc.lettersGap).toMatch(/need 5 more/);
    expect(sc.lettersGap).toMatch(/1 independent expert/);
    expect(renderScorecard(sc, PROFILE)).toContain(sc.lettersGap);
    ledger.close();
  });

  it('never claims the target is met until letters are actually signed', () => {
    const ledger = new Ledger(':memory:');
    ledger.upsertLetter(baseLetter({ letter_id: 'LTR-a', state: 'sent', relationship: 'independent' }));
    const sc = buildScorecard(ledger, PROFILE, NOW, { followers: null, degraded: [], sharingWarnings: [] });
    // Sent, not signed: still counts as a full gap.
    expect(sc.lettersGap).toMatch(/need 5 more/);
    ledger.close();
  });

  it('reports the target met once 5 letters, including an independent one, are signed', () => {
    const ledger = new Ledger(':memory:');
    for (let i = 0; i < 5; i++) {
      const id = `LTR-${i}`;
      ledger.upsertLetter(baseLetter({ letter_id: id, state: 'sent', relationship: i === 0 ? 'independent' : 'dependent' }));
      ledger.event({ run_id: 'r1', trace_id: null, kind: 'signature', detail: { letter_id: id, status: 'signed', signer_email: 'x@example.test' }, at: NOW.toISOString() });
    }
    const sc = buildScorecard(ledger, PROFILE, NOW, { followers: null, degraded: [], sharingWarnings: [] });
    expect(sc.lettersGap).toMatch(/target met/);
    expect(sc.lettersGap).toMatch(/5 of 5 to 8 signed/);
    ledger.close();
  });

  it('scorecard text never says the founder qualifies', () => {
    const ledger = new Ledger(':memory:');
    const sc = buildScorecard(ledger, PROFILE, NOW, { followers: null, degraded: [], sharingWarnings: [] });
    const text = renderScorecard(sc, PROFILE);
    expect(text.toLowerCase()).not.toMatch(/founder qualifies|you qualify/);
    ledger.close();
  });
});

describe('scorecard: worth-sending hold rate and top reasons (PRD 6.8)', () => {
  it('computes a hold rate and groups repeated hold reasons', () => {
    const ledger = new Ledger(':memory:');
    ledger.upsertLetter(baseLetter({ letter_id: 'LTR-1', state: 'held', ws_decision: 'hold', ws_reasons: ['Timing: recipient is busy.'] }));
    ledger.upsertLetter(baseLetter({ letter_id: 'LTR-2', state: 'held', ws_decision: 'hold', ws_reasons: ['Timing: recipient is busy.'] }));
    ledger.upsertLetter(baseLetter({ letter_id: 'LTR-3', state: 'sent', ws_decision: 'send' }));
    const sc = buildScorecard(ledger, PROFILE, NOW, { followers: null, degraded: [], sharingWarnings: [] });
    expect(sc.letters.evaluated).toBe(3);
    expect(sc.letters.heldCount).toBe(2);
    expect(sc.letters.holdRate).toBeCloseTo(2 / 3);
    expect(sc.letters.topHoldReasons[0]).toEqual({ reason: 'Timing: recipient is busy.', count: 2 });
    const text = renderScorecard(sc, PROFILE);
    expect(text).toMatch(/hold rate 67%/);
    expect(text).toContain('Timing: recipient is busy. (2x)');
    ledger.close();
  });

  it('holdRate is null when nothing has been evaluated yet', () => {
    const ledger = new Ledger(':memory:');
    const sc = buildScorecard(ledger, PROFILE, NOW, { followers: null, degraded: [], sharingWarnings: [] });
    expect(sc.letters.evaluated).toBe(0);
    expect(sc.letters.holdRate).toBeNull();
    ledger.close();
  });
});

describe('letters: a "one exhibit from met" criterion also triggers a request (PRD 6.8)', () => {
  async function makeDeps(profile: FounderProfile): Promise<{ deps: LetterDeps; ledger: Ledger }> {
    const twins = new MemoryTwins(seed({}), { now: () => NOW });
    const ledger = new Ledger(':memory:');
    const tracer = new LocalTracer(null);
    const trace = (await tracer.run({ name: 'test', runId: 'r1', input: {} }, async (c) => c)).result;
    const deps: LetterDeps = { apps: twins.apps, ledger, trace, profile, gate: new LibraryWorthSendingGate(), runId: 'r1', now: NOW, allMessages: [], founderMessages: [] };
    return { deps, ledger };
  }

  it('drafts a letter for a recommender named on a needs_attorney exhibit (one exhibit from met), not only a qualifying one', async () => {
    const r = PROFILE.recommenderCandidates[0]!;
    const profile: FounderProfile = { ...PROFILE, recommenderCandidates: [r] };
    const { deps, ledger } = await makeDeps(profile);
    ledger.insertExhibit(
      baseExhibit({
        exhibit_id: 'EX-4-009',
        status: 'needs_attorney',
        people: [{ name: r.name, email: r.email }],
      }),
      'r1',
      null,
    );
    const summary = await processLetters(deps);
    expect(summary.skipped.find((s) => s.email === r.email)).toBeUndefined();
    expect(summary.drafted.length + summary.held.length + summary.approvalRequested.length).toBeGreaterThan(0);
    ledger.close();
  });

  it('still skips a recommender with no qualifying or needs_attorney exhibit linked to them (E23 unaffected)', async () => {
    const r = PROFILE.recommenderCandidates[0]!;
    const profile: FounderProfile = { ...PROFILE, recommenderCandidates: [r] };
    const { deps, ledger } = await makeDeps(profile);
    const summary = await processLetters(deps);
    expect(summary.skipped).toEqual([{ email: r.email, reason: 'no linked qualifying exhibit' }]);
    ledger.close();
  });

  it('does not trigger from a rejected exhibit', async () => {
    const r = PROFILE.recommenderCandidates[0]!;
    const profile: FounderProfile = { ...PROFILE, recommenderCandidates: [r] };
    const { deps, ledger } = await makeDeps(profile);
    ledger.insertExhibit(
      baseExhibit({ exhibit_id: 'EX-4-010', status: 'rejected', eb1a_status: 'rejected', people: [{ name: r.name, email: r.email }] }),
      'r1',
      null,
    );
    const summary = await processLetters(deps);
    expect(summary.skipped.find((s) => s.email === r.email)?.reason).toBe('no linked qualifying exhibit');
    ledger.close();
  });
});
