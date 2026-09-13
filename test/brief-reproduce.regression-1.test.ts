import { describe, expect, it } from 'vitest';
import type { MatrixResult } from '../harness/runner.js';
import { generateBrief } from '../src/brief.js';
import { loadGraph } from '../src/rules/graph.js';

describe('reliability brief reproduction regression', () => {
  it('documents the complete offline flow and separates live verification', () => {
    const matrix: MatrixResult = {
      batchId: 'batch_reproduce_regression',
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
    expect(brief).toContain('npm run demo');
    expect(brief).toContain('npm run eval -- --attempts 3');
    expect(brief).toContain('npm run mutate');
    expect(brief).toContain('npm run verify -- --demo out/demo');
    expect(brief).toContain('expected exit 1');
    expect(brief).toContain('npm run exhibit -- run --live');
  });
});
