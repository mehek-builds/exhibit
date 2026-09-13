import { describe, expect, it } from 'vitest';
import { requeueStaleFigures } from '../src/research/freshness.js';
import { Ledger } from '../src/ledger.js';
import type { FigureRow, FigureSource } from '../src/ledger.js';

const NOW = new Date('2026-09-13T00:00:00.000Z');

function figureRow(p: { fig_id: string; exhibit_id: string; as_of: string; status?: FigureRow['status'] }): FigureRow {
  const source: FigureSource = {
    kind: 'primary',
    url: 'https://issuer.example/press',
    publisher: 'Issuer',
    sentence: 'reaches 1,000,000',
    snapshot_html_id: null,
    snapshot_pdf_id: null,
    snapshot_sha256: 'sha',
    as_of: p.as_of,
  };
  return {
    fig_id: p.fig_id,
    exhibit_id: p.exhibit_id,
    criterion: 3,
    measure: 'monthly readers',
    value: 1_000_000,
    unit: 'monthly readers',
    as_of: p.as_of,
    sources: [source],
    label: 'independently_confirmed',
    note: 'note',
    status: p.status ?? 'approved',
    fingerprint: `fp-${p.fig_id}`,
    detail: null,
    queued_at: '2026-01-01T00:00:00.000Z',
    decided_at: '2026-01-02T00:00:00.000Z',
    decision_reason: 'looks good',
    run_id: 'r1',
    trace_id: null,
  };
}

describe('freshness: figures older than 12 months at export are re-queued', () => {
  it('a 13-month-old approved figure is reset to pending and re-queued for re-research', () => {
    const ledger = new Ledger(':memory:');
    const row = figureRow({ fig_id: 'FIG-001', exhibit_id: 'EX-3-001', as_of: '2025-08-01' }); // 13 months before NOW
    ledger.insertFigure(row);
    ledger.set('corroborated:EX-3-001', '2026-01-02T00:00:00.000Z');

    const result = requeueStaleFigures(ledger, NOW, { runId: 'r1', traceId: null });

    expect(result.staleFigIds).toEqual(['FIG-001']);
    const after = ledger.figure('FIG-001')!;
    expect(after.status).toBe('pending');
    expect(after.decided_at).toBeNull();
    expect(after.decision_reason).toBeNull();
    // Cache key cleared so the Corroborator re-researches the exhibit instead of skipping it.
    expect(ledger.get('corroborated:EX-3-001')).toBe('');
    // on_sheet flag cleared so queueFigures appends a fresh row instead of leaving the stale
    // Approve on the old row as the only record of this figure in the Sheet (see queue.ts).
    expect(ledger.get('on_sheet:FIG-001')).toBe('');
    // Not written into context notes: it is no longer `approved`, so decideFigure's
    // `status !== 'pending'` guard requires a fresh founder decision before any write happens.
    expect(after.status).not.toBe('approved');
    const events = ledger.events({ kind: 'figure_stale' });
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toMatchObject({ fig_id: 'FIG-001', exhibit_id: 'EX-3-001' });
  });

  it('an 11-month-old approved figure is left untouched', () => {
    const ledger = new Ledger(':memory:');
    const row = figureRow({ fig_id: 'FIG-002', exhibit_id: 'EX-3-002', as_of: '2025-10-20' }); // 11 months before NOW
    ledger.insertFigure(row);
    ledger.set('corroborated:EX-3-002', '2026-01-02T00:00:00.000Z');

    const result = requeueStaleFigures(ledger, NOW, { runId: 'r1', traceId: null });

    expect(result.staleFigIds).toEqual([]);
    const after = ledger.figure('FIG-002')!;
    expect(after.status).toBe('approved');
    expect(after.decided_at).not.toBeNull();
    expect(ledger.get('corroborated:EX-3-002')).toBe('2026-01-02T00:00:00.000Z');
    expect(ledger.events({ kind: 'figure_stale' })).toHaveLength(0);
  });

  it('a figure the founder re-approved after it went stale is kept, so it does not re-queue every run', () => {
    const ledger = new Ledger(':memory:');
    const row = { ...figureRow({ fig_id: 'FIG-004', exhibit_id: 'EX-3-004', as_of: '2025-01-01' }), decided_at: '2026-09-01T00:00:00.000Z' };
    ledger.insertFigure(row);

    const result = requeueStaleFigures(ledger, NOW, { runId: 'r1', traceId: null });

    expect(result.staleFigIds).toEqual([]);
    expect(ledger.figure('FIG-004')!.status).toBe('approved');
    expect(ledger.events({ kind: 'figure_stale' })).toHaveLength(0);
  });

  it('a pending (not yet approved) figure is never touched, regardless of age', () => {
    const ledger = new Ledger(':memory:');
    const row = figureRow({ fig_id: 'FIG-003', exhibit_id: 'EX-3-003', as_of: '2024-01-01', status: 'pending' });
    ledger.insertFigure(row);

    const result = requeueStaleFigures(ledger, NOW, { runId: 'r1', traceId: null });

    expect(result.staleFigIds).toEqual([]);
    expect(ledger.figure('FIG-003')!.status).toBe('pending');
  });
});
