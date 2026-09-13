import { describe, expect, it } from 'vitest';
import type { MatrixResult } from '../harness/runner.js';
import { generateBrief } from '../src/brief.js';
import { loadGraph } from '../src/rules/graph.js';

describe('reliability brief security status regression', () => {
  it('reports the per-finding fixed statuses from the security review', () => {
    const matrix: MatrixResult = {
      batchId: 'batch_security_regression',
      release: 'testsha',
      backend: 'memory',
      model: 'heuristic',
      gateTransport: 'mcp',
      startedAt: '2026-09-13T00:00:00Z',
      finishedAt: '2026-09-13T00:01:00Z',
      attempts: [],
      stats: [],
      allCorePassed: true,
    };

    const brief = generateBrief({ eval: matrix, graph: loadGraph() });
    expect(brief).toContain('H1, M1, M2 and L1 are marked fixed');
    expect(brief).not.toContain('still open, no patch applied yet');
  });
});
