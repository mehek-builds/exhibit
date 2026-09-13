import { describe, expect, it } from 'vitest';
import { runScenarioAttempt } from '../harness/runner.js';
import type { AttemptResult } from '../harness/runner.js';
import { S27 } from '../harness/scenarios/s27-audit-modes.js';
import { detectorLabels } from '../src/loop/detector.js';
import type { MatrixResult } from '../harness/runner.js';

// PRD 12.4 claims the trace audit (src/observability/audit.ts) catches all seven failure modes. Today's graded runs only ever exercise `hallucination` (S17's seeded
// figure), so this suite is the first proof that the other six are actually detected: one injected
// fault per mode (harness/scenarios/s27-audit-modes.ts), plus a clean control run.
//
// Each fault scenario's `grade()` includes a deliberately-failing check stating the underlying defect
// in task terms (e.g. "the qualifying item was actually filed" -- false, because the fault dropped it).
// That is intentional and expected here: it is what makes this a genuine graded failure for
// src/loop/detector.ts to reason about, not a scenario whose checks are all green regardless of the
// injected bug. The "audit raises <mode>" check is the one that must always pass.

function byId(id: string) {
  const s = S27.find((x) => x.id === id);
  if (!s) throw new Error(`scenario ${id} not found in S27`);
  return s;
}

async function attempt(id: string): Promise<AttemptResult> {
  return runScenarioAttempt(byId(id), 1, {});
}

function auditCheck(r: AttemptResult, mode: string) {
  return r.checks.find((c) => c.name.startsWith(`audit raises ${mode}`));
}

describe('S27: the trace audit detects each of the seven failure modes', () => {
  it('skipped_work: a qualifying item whose filing was dropped is caught', async () => {
    const r = await attempt('S27-skipped-work');
    expect(r.error).toBeUndefined();
    expect(auditCheck(r, 'skipped_work')?.pass).toBe(true);
    expect(r.issues.some((i) => i.mode === 'skipped_work')).toBe(true);
  });

  it('out_of_scope_work: an extension writing to Calendar is caught by the audit AND prohibitedSideEffects', async () => {
    const r = await attempt('S27-out-of-scope-work');
    expect(r.error).toBeUndefined();
    expect(auditCheck(r, 'out_of_scope_work')?.pass).toBe(true);
    expect(r.issues.some((i) => i.mode === 'out_of_scope_work' && i.constraint === 7)).toBe(true);
    expect(r.sideEffects.some((s) => s.kind === 'out_of_scope_write')).toBe(true);
  });

  it('instruction_violation: an agent-authored send without approval is caught', async () => {
    const r = await attempt('S27-instruction-violation');
    expect(r.error).toBeUndefined();
    expect(auditCheck(r, 'instruction_violation')?.pass).toBe(true);
    expect(r.issues.some((i) => i.mode === 'instruction_violation' && i.constraint === 1)).toBe(true);
    expect(r.sideEffects.some((s) => s.kind === 'send_without_approval')).toBe(true);
  });

  it('integration_failure: a web-fetch outage during corroboration is caught', async () => {
    const r = await attempt('S27-integration-failure');
    expect(r.error).toBeUndefined();
    expect(auditCheck(r, 'integration_failure')?.pass).toBe(true);
    expect(r.issues.some((i) => i.mode === 'integration_failure')).toBe(true);
  });

  it('retry_loop: an identical tool call repeated four times is caught', async () => {
    const r = await attempt('S27-retry-loop');
    expect(r.error).toBeUndefined();
    expect(auditCheck(r, 'retry_loop')?.pass).toBe(true);
    expect(r.issues.some((i) => i.mode === 'retry_loop')).toBe(true);
  });

  it('communication_failure: a scorecard that disagrees with the ledger is caught', async () => {
    const r = await attempt('S27-communication-failure');
    expect(r.error).toBeUndefined();
    expect(auditCheck(r, 'communication_failure')?.pass).toBe(true);
    expect(r.issues.some((i) => i.mode === 'communication_failure' && i.constraint === 11)).toBe(true);
  });

  it('control: a clean run raises none of the six non-seeded modes', async () => {
    const r = await attempt('S27-control');
    expect(r.error).toBeUndefined();
    expect(r.checks.every((c) => c.pass)).toBe(true);
    const nonSeeded = new Set(['skipped_work', 'out_of_scope_work', 'instruction_violation', 'integration_failure', 'retry_loop', 'communication_failure']);
    expect(r.issues.filter((i) => nonSeeded.has(i.mode))).toEqual([]);
  });

  it('every fault attempt is correctly labeled by src/loop/detector.ts (not a false alarm, not missed)', async () => {
    const faultIds = ['S27-skipped-work', 'S27-out-of-scope-work', 'S27-instruction-violation', 'S27-integration-failure', 'S27-retry-loop', 'S27-communication-failure'];
    const attempts: AttemptResult[] = [];
    for (const id of faultIds) attempts.push(await attempt(id));
    // Every fault here leaves at least one deliberately-failing check (the underlying defect, in task
    // terms), so the detector sees a genuine graded failure and should label each raised issue
    // 'correct' -- never 'false_alarm', and the failure itself never 'missed'.
    const matrix: MatrixResult = {
      batchId: 'test', release: 'test', backend: 'memory', model: 'test', gateTransport: 'mcp',
      startedAt: '', finishedAt: '', attempts, stats: [], allCorePassed: false,
    };
    const summary = detectorLabels(matrix);
    expect(summary.counts.missed).toBe(0);
    expect(summary.counts.false_alarm).toBe(0);
    expect(summary.counts.correct).toBeGreaterThanOrEqual(faultIds.length);
  });
});
