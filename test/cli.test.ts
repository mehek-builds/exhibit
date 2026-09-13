import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { AttemptResult, MatrixResult } from '../harness/runner.js';
import type { RunSummary } from '../src/agent.js';
import { generateBrief } from '../src/brief.js';
import { currentRelease } from '../src/release.js';
import { affected, loadGraph } from '../src/rules/graph.js';

// Small checks over generateBrief, affected() and currentRelease(): CLI conventions §"Verify".

function runSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: 'run_1',
    traceId: 'tr_1',
    outcome: 'ok',
    itemsRead: 10,
    candidates: 5,
    filed: ['EX-1-001'],
    hallucinations: [],
    modelCalls: 3,
    review: { approved: ['FIG-001'], denied: ['FIG-002'], pending: ['FIG-003'], flagged: [], digestSent: true, degraded: [] },
    corroboration: {
      researched: 2,
      proposed: 3,
      queued: [
        { fig_id: 'FIG-001', exhibit_id: 'EX-1-001', criterion: 1, measure: 'entrants', value: 310, unit: 'count', as_of: '2026-04-01', sources: [], label: 'independently_confirmed', note: 'note', status: 'approved', fingerprint: 'fp1', detail: null, queued_at: '2026-04-01T00:00:00Z', decided_at: '2026-04-01T00:00:00Z', decision_reason: null, run_id: 'run_1', trace_id: 'tr_1' },
      ],
      blocked: [{ url: 'https://similarweb.example/x', reason: 'not an allowed domain' }],
      hallucinations: [{ url: 'https://launchfest.example/2026/winners', sentence: 'not on the page' }],
      conflicting: 1,
      insufficient: 1,
      cacheHits: 0,
      limited: 0,
      errors: [],
    },
    letters: {
      evaluated: 2,
      drafted: ['LTR-priya'],
      held: [{ letter_id: 'LTR-sam', reasons: ['Recipient signalled they are busy right now.'] }],
      approvalRequested: ['LTR-priya'],
      sent: [],
      skipped: [],
      decisions: [{ letter_id: 'LTR-priya', decision: 'send', score: 82 }],
    },
    scorecard: null,
    scorecardText: 'O-1A: 7 of 8 criteria met (3 required).\nEB-1A: 7 of 10 criteria met (3 required).\n',
    issues: [{ mode: 'hallucination', constraint: 3, title: 'Hallucinated quote discarded', detail: 'x', traceId: 'tr_1', fingerprint: 'hallucination:x' }],
    degraded: [],
    extensionErrors: [],
    durationMs: 1200,
    summary: {},
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
    checks: [
      { name: 'trap_rejection', pass: true, detail: '5 of 5 traps rejected' },
      { name: 'must_count_recall', pass: true, detail: '6 of 6 must-count items filed qualifying' },
    ],
    sideEffects: [],
    stubHits: [],
    runs: [runSummary()],
    issues: [{ mode: 'hallucination', constraint: 3, title: 'Hallucinated quote discarded', detail: 'x', traceId: 'tr_1', fingerprint: 'hallucination:x' }],
    durationMs: 1200,
    ...overrides,
  };
}

function tinyMatrix(): MatrixResult {
  return {
    batchId: 'batch_test',
    release: 'testsha',
    backend: 'memory',
    model: 'heuristic',
    gateTransport: 'mcp',
    startedAt: '2026-09-13T00:00:00Z',
    finishedAt: '2026-09-13T00:05:00Z',
    attempts: [attempt()],
    stats: [{ scenarioId: 'S1', title: 'Full synthetic year', core: true, attempts: 1, passed: 1, sideEffects: 0 }],
    allCorePassed: true,
  };
}

describe('generateBrief', () => {
  const graph = loadGraph();
  const brief = generateBrief({ eval: tinyMatrix(), graph });

  it('includes every required section', () => {
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

  it('renders numbers computed from the input, not invented ones', () => {
    expect(brief).toContain('S1');
    expect(brief).toContain('1/1');
    expect(brief).toContain('Figures proposed | 3');
    expect(brief).toContain('Letter requests evaluated | 2');
    expect(brief).toContain(tinyMatrix().batchId);
  });

  it('states plainly that this run used twins and fixtures, not Arga', () => {
    expect(brief).toMatch(/in-memory twins/);
    expect(brief).toMatch(/not Arga's hosted twins/);
  });
});

describe('affected', () => {
  it('finds the mapper among decisions-5-5 dependents', () => {
    const graph = loadGraph();
    const result = affected(graph, ['decisions-5-5']);
    expect(result.prompts).toContain('mapper');
    expect(result.scenarios.length).toBeGreaterThan(0);
  });
});

describe('currentRelease', () => {
  it('returns a non-empty string', () => {
    expect(currentRelease().length).toBeGreaterThan(0);
  });
});

describe('cli affected command', () => {
  it('lists the mapper for decisions-5-5', () => {
    const out = execFileSync(process.execPath, ['node_modules/.bin/tsx', 'src/cli.ts', 'affected', 'decisions-5-5'], { cwd: process.cwd(), encoding: 'utf8' });
    expect(out).toContain('mapper');
  });
});
