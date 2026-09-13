import { describe, expect, it } from 'vitest';
import type { MatrixResult } from '../harness/runner.js';
import { generateBrief } from '../src/brief.js';
import { loadGraph } from '../src/rules/graph.js';

describe('reliability brief integrity regression', () => {
  it('counts failed file records instead of coercing their array to NaN', () => {
    const matrix: MatrixResult = {
      batchId: 'batch_integrity_regression',
      release: 'testsha',
      backend: 'memory',
      model: 'heuristic',
      gateTransport: 'mcp',
      startedAt: '2026-09-13T00:00:00Z',
      finishedAt: '2026-09-13T00:01:00Z',
      allCorePassed: true,
      stats: [],
      attempts: [{
        scenarioId: 'S22',
        title: 'Integrity',
        core: true,
        attempt: 1,
        passed: true,
        checks: [],
        sideEffects: [],
        stubHits: [],
        runs: [],
        issues: [],
        durationMs: 1,
        metrics: {
          backend: 'memory',
          eventCounts: { verify: 1 },
          stubHits: [],
          events: [{
            kind: 'verify',
            detail: { passed: 5, failed: [{ path: 'changed.eml', reason: 'digest mismatch' }] },
            at: '2026-09-13T00:00:30Z',
          }],
        },
      }],
    };

    const brief = generateBrief({ eval: matrix, graph: loadGraph() });
    expect(brief).toContain('untouched files passing / altered file caught | 5 / 1 |');
    expect(brief).not.toContain('NaN');
  });
});
