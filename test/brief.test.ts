import { describe, expect, it } from 'vitest';
import type { AttemptMetrics, AttemptResult, MatrixResult } from '../harness/runner.js';
import type { RunSummary } from '../src/agent.js';
import { generateBrief } from '../src/brief.js';
import { loadGraph } from '../src/rules/graph.js';

// Owned by src/brief.ts (file-ownership rules). Proves every template section renders from a
// hand-built MatrixResult, placeholders never leak, missing data reads "not run", and no "live"
// claim appears without a live-transport event (constraint 19).

function runSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: 'run_1',
    traceId: 'tr_1',
    outcome: 'ok',
    itemsRead: 1,
    candidates: 1,
    filed: ['EX-1-001'],
    hallucinations: [],
    modelCalls: 1,
    review: null,
    corroboration: null,
    letters: null,
    scorecard: null,
    scorecardText: null,
    issues: [],
    degraded: [],
    extensionErrors: [],
    durationMs: 10,
    summary: {},
    ...overrides,
  };
}

function metrics(overrides: Partial<AttemptMetrics> = {}): AttemptMetrics {
  return {
    eventCounts: {},
    events: [],
    stubHits: [],
    backend: 'memory',
    ...overrides,
  };
}

function attempt(overrides: Partial<AttemptResult> = {}): AttemptResult {
  return {
    scenarioId: 'S1',
    title: 'Full synthetic year',
    core: true,
    attempt: 1,
    passed: true,
    checks: [{ name: 'exactly 14 qualifying candidates', pass: true, detail: 'got 14' }],
    sideEffects: [],
    stubHits: [],
    runs: [runSummary()],
    issues: [],
    durationMs: 10,
    metrics: metrics(),
    ...overrides,
  };
}

function baseMatrix(): MatrixResult {
  return {
    batchId: 'batch_brief_test',
    release: 'testsha',
    backend: 'memory',
    model: 'heuristic',
    gateTransport: 'mcp',
    startedAt: '2026-09-13T00:00:00Z',
    finishedAt: '2026-09-13T00:05:00Z',
    attempts: [attempt()],
    stats: [{ scenarioId: 'S1', title: 'Full synthetic year', core: true, attempts: 1, passed: 1, sideEffects: 0 }],
    allCorePassed: false,
  };
}

const graph = loadGraph();

describe('generateBrief (template coverage)', () => {
  const brief = generateBrief({ eval: baseMatrix(), graph });

  it('renders every template section', () => {
    for (const heading of [
      '## 1. What it does',
      '## 2. System in one paragraph',
      '## 3. How we know it works',
      '## 4. Hard constraints',
      '## 5. Before real data: Arga',
      '## 6. On every run: the trace audit',
      '## 7. When it contacts a person: Userlens worth-sending',
      '## 8. When a rule changes: Clera uberprompt',
      '## 9. The loop, closed',
      '## 10. Research and approval: context figures',
      '## 10b. Integrity and integrations',
      '## 11. What was real and what was simulated',
      '## 12. Known limits',
      '## 13. Reproduce',
      '## 14. What this build hands back to each platform',
    ]) {
      expect(brief).toContain(heading);
    }
  });

  it('never leaves a template placeholder unfilled', () => {
    expect(brief).not.toContain('{{');
  });

  it('marks scenarios absent from the batch as "not run"', () => {
    // Only S1 ran in this batch; S2..S24 must read "not run" or "cut", never a fabricated number.
    expect(brief).toMatch(/S2 \|[^\n]*\| not run \| not run \|/);
    expect(brief).toMatch(/S20 \|[^\n]*\| cut \| cut \|/);
  });

  it('keeps the closing line', () => {
    expect(brief).toContain('Arga is where it was allowed to fail. The trace audit is how I know it stopped. Userlens decides when it may bother a human. Clera shows what a rule change touched.');
  });

  it('reports known limits honestly for the heuristic model', () => {
    expect(brief).toMatch(/heuristic stand-in, not Claude/);
  });
});

describe('generateBrief (known answers from S1 ground truth)', () => {
  it('reads real trap/must-count/recall numbers when S1 has metrics.groundTruth', () => {
    const m = baseMatrix();
    m.attempts[0]!.metrics = metrics({
      groundTruth: {
        trapsFiledQualifying: 0,
        trapsTotal: 5,
        mustCountFiledQualifying: 4,
        mustCountTotal: 4,
        qualifyingHit: 9,
        qualifyingTotal: 10,
        qualifyingRecall: 0.9,
        dateHit: 14,
        dateTotal: 14,
        dateAccuracy: 1,
        dualHit: 20,
        dualTotal: 20,
        dualAccuracy: 1,
      },
    });
    const brief = generateBrief({ eval: m, graph });
    expect(brief).toContain('0 of 5');
    expect(brief).toContain('4 of 4');
    expect(brief).not.toContain('{{');
  });

  it('reads "not run" for known answers when S1 was not part of the batch', () => {
    const m = baseMatrix();
    m.attempts = [];
    m.stats = [];
    const brief = generateBrief({ eval: m, graph });
    expect(brief).toMatch(/Traps filed as qualifying \| not run \|/);
  });
});

describe('generateBrief (no live claim without a live event)', () => {
  it('says fixtures only when no live-transport event was recorded', () => {
    const brief = generateBrief({ eval: baseMatrix(), graph });
    expect(brief).toMatch(/no live web research event was recorded/);
  });

  it('claims live only when an integration_call event carries transport: live', () => {
    const m = baseMatrix();
    m.attempts[0]!.metrics = metrics({
      eventCounts: { integration_call: 1 },
      events: [{ kind: 'integration_call', detail: { integration: 'gdelt', op: 'search', ok: true, transport: 'live' }, at: '2026-09-13T00:01:00Z' }],
    });
    const brief = generateBrief({ eval: m, graph });
    expect(brief).toMatch(/Live calls were recorded in this batch/);
  });
});

describe('generateBrief (backend memory => memory twins, not Arga)', () => {
  it('section 11 names the in-memory twins explicitly', () => {
    const brief = generateBrief({ eval: baseMatrix(), graph });
    expect(brief).toMatch(/Exhibit's in-memory twins, not Arga's hosted twins/);
  });
});

describe('generateBrief (mutation table renders in section 5, after known answers)', () => {
  it('says not run when no MutationResult is passed', () => {
    const without = generateBrief({ eval: baseMatrix(), graph });
    expect(without).toMatch(/Mutation results: not run in this batch/);
  });

  it('renders the full mutation table and distinguishes survivors from killed mutations', () => {
    const withMutation = generateBrief({
      eval: baseMatrix(),
      graph,
      mutation: {
        mutations: [
          { name: 'disable D-accelerator-acceptance', disabled: ['D-accelerator-acceptance'], scenario: 'S2', killed: true, detail: 'went red' },
          { name: 'disable X-integrity-tamper-check', disabled: ['X-integrity-tamper-check'], scenario: 'S22', killed: false, detail: 'verify still passed' },
        ],
      },
    });
    // Both mutations appear.
    expect(withMutation).toContain('disable D-accelerator-acceptance');
    expect(withMutation).toContain('disable X-integrity-tamper-check');
    // Killed vs. survived are rendered with visibly different text.
    expect(withMutation).toContain('killed (went red as expected)');
    expect(withMutation).toMatch(/SURVIVED/);
    // The mutation table appears after section 5's known-answers table, before section 6.
    const s5 = withMutation.indexOf('## 5. Before real data: Arga');
    const knownAnswers = withMutation.indexOf('Known answers:');
    const mutationRow = withMutation.indexOf('disable D-accelerator-acceptance');
    const s6 = withMutation.indexOf('## 6. On every run: the trace audit');
    expect(s5).toBeGreaterThan(-1);
    expect(knownAnswers).toBeGreaterThan(s5);
    expect(mutationRow).toBeGreaterThan(knownAnswers);
    expect(s6).toBeGreaterThan(mutationRow);
  });
});

describe('generateBrief (Arga backend risks render in section 5)', () => {
  it('states the two ARGA.md UNCONFIRMED risks in plain language', () => {
    const brief = generateBrief({ eval: baseMatrix(), graph });
    expect(brief).toMatch(/seed_config/);
    expect(brief).toMatch(/op log/);
    expect(brief).toMatch(/never been run against the real service/);
  });
});

describe('generateBrief (live claims gated by LIVE-SMOKE.md)', () => {
  it('claims live (smoke) only for services LIVE-SMOKE.md marks ok, and not for gdelt/semanticscholar as positive results', () => {
    const brief = generateBrief({ eval: baseMatrix(), graph });
    expect(brief).toMatch(/Hacker News \(smoke: one request, keyless; exercised live\)/);
    expect(brief).toMatch(/GDELT \(smoke: one request, keyless; ran only on an empty result/);
    expect(brief).not.toMatch(/Semantic Scholar \(smoke: one request, keyless/);
    expect(brief).toMatch(/Semantic Scholar \(inconclusive/);
    expect(brief).not.toMatch(/in production/);
  });
});
