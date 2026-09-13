import { describe, expect, it } from 'vitest';
import { buildScorecard, parseScorecardCounts, renderScorecard } from '../src/binder/scorecard.js';
import { Ledger } from '../src/ledger.js';
import { NOW } from '../harness/corpus.js';
import { PROFILE } from './helpers.js';

const CTX = { followers: null, degraded: [], sharingWarnings: [] };

describe('scorecard v2: letters for signature (6.14, E66)', () => {
  it('reports created/signed/declined/expired and returns declined letters to the scorecard', () => {
    const ledger = new Ledger(':memory:');
    ledger.event({ run_id: 'r1', trace_id: null, kind: 'signature', at: NOW.toISOString(), detail: { request_id: 'req-1', letter_id: 'L1', status: 'created', test_mode: true, signer_email: 'a@example.com' } });
    ledger.event({ run_id: 'r1', trace_id: null, kind: 'signature', at: NOW.toISOString(), detail: { request_id: 'req-2', letter_id: 'L2', status: 'created', test_mode: true, signer_email: 'b@example.com' } });
    ledger.event({ run_id: 'r1', trace_id: null, kind: 'signature', at: NOW.toISOString(), detail: { request_id: 'req-2', letter_id: 'L2', status: 'signed', test_mode: true, signer_email: 'b@example.com' } });
    ledger.event({ run_id: 'r1', trace_id: null, kind: 'signature', at: NOW.toISOString(), detail: { request_id: 'req-3', letter_id: 'L3', status: 'created', test_mode: true, signer_email: 'c@example.com' } });
    ledger.event({ run_id: 'r1', trace_id: null, kind: 'signature', at: NOW.toISOString(), detail: { request_id: 'req-3', letter_id: 'L3', status: 'declined', test_mode: true, signer_email: 'c@example.com' } });

    const sc = buildScorecard(ledger, PROFILE, NOW, CTX);
    expect(sc.signatures?.created).toBe(1);
    expect(sc.signatures?.signed).toBe(1);
    expect(sc.signatures?.declined).toBe(1);
    expect(sc.signatures?.expired).toBe(0);
    const declined = sc.signatures?.rows.find((r) => r.letterId === 'L3');
    expect(declined?.nextAction).toBe('ask again or choose another recommender');

    const text = renderScorecard(sc, PROFILE);
    expect(text).toContain('Letters for signature: 1 requested, 1 signed, 1 declined, 0 expired.');
    expect(text).toContain('L3 (c@example.com) declined, returned to the scorecard: ask again or choose another recommender');
    ledger.close();
  });
});

describe('scorecard v2: translation (E67)', () => {
  it('counts items needing translation, drafts produced, and items waiting for opt-in', () => {
    const ledger = new Ledger(':memory:');
    ledger.event({ run_id: 'r1', trace_id: null, kind: 'translation', at: NOW.toISOString(), detail: { source: 'x:1', opted_in: false, called: false, chars: 0 } });
    ledger.event({ run_id: 'r1', trace_id: null, kind: 'translation', at: NOW.toISOString(), detail: { source: 'x:2', opted_in: true, called: true, chars: 120 } });

    const sc = buildScorecard(ledger, PROFILE, NOW, CTX);
    expect(sc.translation).toEqual({ needingTranslation: 2, draftsProduced: 1, waitingForOptIn: 1 });

    const text = renderScorecard(sc, PROFILE);
    expect(text).toContain('Translation: 2 item(s) need a certified translation, 1 draft(s) produced, 1 waiting for opt-in.');
    ledger.close();
  });

  it('omits the translation section when there are no translation events', () => {
    const ledger = new Ledger(':memory:');
    const sc = buildScorecard(ledger, PROFILE, NOW, CTX);
    const text = renderScorecard(sc, PROFILE);
    expect(text).not.toContain('Translation:');
    ledger.close();
  });
});

describe('scorecard v2: tamper-evidence (E63)', () => {
  it('counts stamped artifacts, confirmed vs pending, and names a failed file from the last verify', () => {
    const ledger = new Ledger(':memory:');
    ledger.event({ run_id: 'r1', trace_id: null, kind: 'timestamp', at: NOW.toISOString(), detail: { file_id: 'f1', exhibit_id: 'EX-1-001', sha256: 'a', ots_file_id: 'ots1', status: 'pending' } });
    ledger.event({ run_id: 'r1', trace_id: null, kind: 'timestamp', at: NOW.toISOString(), detail: { file_id: 'f1', ots_file_id: 'ots1', sha256: 'a', status: 'confirmed' } });
    ledger.event({ run_id: 'r1', trace_id: null, kind: 'timestamp', at: NOW.toISOString(), detail: { file_id: 'f2', exhibit_id: 'EX-2-001', sha256: 'b', ots_file_id: 'ots2', status: 'pending' } });
    ledger.event({ run_id: 'verify', trace_id: null, kind: 'verify', at: NOW.toISOString(), detail: { files_checked: 2, passed: 1, failed: [{ path: 'f2.pdf', reason: 'sha256 mismatch' }] } });

    const sc = buildScorecard(ledger, PROFILE, NOW, CTX);
    expect(sc.tamperEvidence?.stamped).toBe(2);
    expect(sc.tamperEvidence?.confirmed).toBe(1);
    expect(sc.tamperEvidence?.pending).toBe(1);
    expect(sc.tamperEvidence?.lastVerify).toEqual({ filesChecked: 2, passed: 1, failed: ['f2.pdf'] });

    const text = renderScorecard(sc, PROFILE);
    expect(text).toContain('Tamper-evidence: 2 artifact(s) stamped, 1 confirmed, 1 pending.');
    expect(text).toContain('last verify: 1 of 2 passed, failed: f2.pdf');
    ledger.close();
  });
});

describe('scorecard v2: discovery', () => {
  it('splits candidates found, rejected by the second-identifier rule, and merged duplicates per source', () => {
    const ledger = new Ledger(':memory:');
    ledger.event({ run_id: 'r1', trace_id: null, kind: 'discovery', at: NOW.toISOString(), detail: { source: 'gdelt', external_id: '1', url: 'https://a.example', outcome: 'candidate' } });
    ledger.event({ run_id: 'r1', trace_id: null, kind: 'discovery', at: NOW.toISOString(), detail: { source: 'gdelt', external_id: '2', url: 'https://b.example', outcome: 'second_identifier_reject' } });
    ledger.event({ run_id: 'r1', trace_id: null, kind: 'discovery', at: NOW.toISOString(), detail: { source: 'gdelt', external_id: '3', url: 'https://c.example', outcome: 'duplicate' } });

    const sc = buildScorecard(ledger, PROFILE, NOW, CTX);
    expect(sc.discovery).toEqual([{ source: 'gdelt', found: 1, rejected: 1, merged: 1 }]);

    const text = renderScorecard(sc, PROFILE);
    expect(text).toContain('- gdelt: 1 found, 1 rejected (second-identifier rule), 1 merged with an inbox item');
    ledger.close();
  });
});

describe('scorecard v2: text thread (6.13)', () => {
  it('shows paused-until and texts-stopped state from kv', () => {
    const ledger = new Ledger(':memory:');
    ledger.set('letters_paused_until', '2026-09-20T00:00:00.000Z');
    ledger.set('texts_stopped', '1');

    const sc = buildScorecard(ledger, PROFILE, NOW, CTX);
    expect(sc.textThread).toEqual({ lettersPausedUntil: '2026-09-20T00:00:00.000Z', textsStopped: true });

    const text = renderScorecard(sc, PROFILE);
    expect(text).toContain('letter requests paused until 2026-09-20T00:00:00.000Z');
    expect(text).toContain('texts stopped');
    ledger.close();
  });

  it('omits the text-thread section when nothing is paused or stopped', () => {
    const ledger = new Ledger(':memory:');
    const sc = buildScorecard(ledger, PROFILE, NOW, CTX);
    const text = renderScorecard(sc, PROFILE);
    expect(text).not.toContain('Text thread:');
    ledger.close();
  });
});

describe('scorecard v2: deferred by free-tier limits (E68)', () => {
  it('lists integrations whose limited call deferred a figure to tomorrow', () => {
    const ledger = new Ledger(':memory:');
    ledger.event({ run_id: 'r1', trace_id: null, kind: 'integration_call', at: NOW.toISOString(), detail: { integration: 'openalex', op: 'discover', ok: true, transport: 'live', status: 'limited' } });
    ledger.event({ run_id: 'r1', trace_id: null, kind: 'integration_call', at: NOW.toISOString(), detail: { integration: 'bls', op: 'discover', ok: true, transport: 'live', status: 'ok' } });

    const sc = buildScorecard(ledger, PROFILE, NOW, CTX);
    expect(sc.deferred).toEqual({ integrations: ['openalex'], count: 1 });

    const text = renderScorecard(sc, PROFILE);
    expect(text).toContain('Deferred by free-tier limits: openalex (queued for tomorrow).');
    ledger.close();
  });
});

describe('scorecard v2: parseScorecardCounts still round-trips with the new sections present', () => {
  it('recovers the same O-1A/EB-1A counts even with signatures, translation, and discovery data', () => {
    const ledger = new Ledger(':memory:');
    ledger.event({ run_id: 'r1', trace_id: null, kind: 'signature', at: NOW.toISOString(), detail: { request_id: 'req-1', letter_id: 'L1', status: 'declined', test_mode: true, signer_email: 'a@example.com' } });
    ledger.event({ run_id: 'r1', trace_id: null, kind: 'translation', at: NOW.toISOString(), detail: { source: 'x:1', opted_in: false, called: false, chars: 0 } });
    ledger.event({ run_id: 'r1', trace_id: null, kind: 'discovery', at: NOW.toISOString(), detail: { source: 'gdelt', external_id: '1', url: 'https://a.example', outcome: 'candidate' } });

    const sc = buildScorecard(ledger, PROFILE, NOW, CTX);
    const text = renderScorecard(sc, PROFILE);
    const parsed = parseScorecardCounts(text);
    expect(parsed.o1).toBe(sc.o1Met);
    expect(parsed.eb1).toBe(sc.eb1Met);
    expect(text).not.toContain('qualifies for');
    ledger.close();
  });
});
