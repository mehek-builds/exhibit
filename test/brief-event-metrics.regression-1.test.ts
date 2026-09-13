import { describe, expect, it } from 'vitest';
import type { MatrixResult } from '../harness/runner.js';
import { generateBrief } from '../src/brief.js';
import { loadGraph } from '../src/rules/graph.js';

describe('reliability brief event metrics', () => {
  it('uses the emitted discovery outcomes and counts only created signature events', () => {
    const events = [
      { kind: 'discovery', detail: { source: 'gdelt', outcome: 'candidate' }, at: '2026-09-13T00:00:00Z' },
      { kind: 'discovery', detail: { source: 'gdelt', outcome: 'second_identifier_reject' }, at: '2026-09-13T00:00:01Z' },
      { kind: 'discovery', detail: { source: 'gdelt', outcome: 'duplicate' }, at: '2026-09-13T00:00:02Z' },
      { kind: 'signature', detail: { status: 'created', recommender_confirmed: true, founder_approved: true }, at: '2026-09-13T00:00:03Z' },
      { kind: 'signature', detail: { status: 'signed' }, at: '2026-09-13T00:00:04Z' },
      { kind: 'signature', detail: { status: 'declined' }, at: '2026-09-13T00:00:05Z' },
    ];
    const matrix: MatrixResult = {
      batchId: 'batch_event_metrics',
      release: 'testsha',
      backend: 'memory',
      model: 'heuristic',
      gateTransport: 'mcp',
      startedAt: '2026-09-13T00:00:00Z',
      finishedAt: '2026-09-13T00:01:00Z',
      attempts: [{
        scenarioId: 'S21',
        title: 'metrics',
        core: false,
        attempt: 1,
        passed: true,
        checks: [],
        sideEffects: [],
        stubHits: [],
        runs: [],
        issues: [],
        durationMs: 1,
        metrics: { backend: 'memory', eventCounts: { discovery: 3, signature: 3 }, events, stubHits: [] },
      }],
      stats: [],
      allCorePassed: true,
    };

    const brief = generateBrief({ eval: matrix, graph: loadGraph() });
    expect(brief).toContain('| gdelt | 3 | 1 | 1 | 1 |');
    expect(brief).toContain('1 created, 1 signed, 1 declined, and 0 created without both approvals');
    expect(brief).not.toContain('Became exhibits');
  });
});
