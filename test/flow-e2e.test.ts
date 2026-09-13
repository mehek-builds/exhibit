import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runFlow } from '../src/commands/flow.js';

// PRD section 4.1/6.1-6.14/8/10 end-to-end: every stage of `exhibit flow` must actually run and
// carry non-empty, concrete evidence -- not merely report a count of stages. The second test proves
// the flow cannot pass vacuously: disabling a real rule must flip at least one stage to FAIL.

describe('exhibit flow (end-to-end, mock data)', () => {
  it('runs all 17 stages with non-empty evidence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'exhibit-flow-'));
    try {
      const report = await runFlow({ outDir: dir });
      expect(report.stages.length).toBe(17);
      for (const s of report.stages) {
        expect(s.evidence.length, `${s.id} has evidence`).toBeGreaterThan(0);
        for (const line of s.evidence) expect(line.length).toBeGreaterThan(0);
      }
      const failing = report.stages.filter((s) => !s.pass);
      expect(failing, `all stages pass: ${JSON.stringify(failing.map((s) => ({ id: s.id, evidence: s.evidence })), null, 2)}`).toEqual([]);
      expect(report.passed).toBe(17);
      expect(report.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('cannot pass vacuously: disabling the second-identifier rule flips the discovery stage to FAIL', async () => {
    // src/discovery/extension.ts checks `ruleOptions.disabled` for 'X-second-identifier' before
    // rejecting a namesake/look-alike item; disabling it here is a genuine mutation-style tamper
    // (harness/grade.ts and verifyBinder's own `ruleOptions.disabled` param use the same lever),
    // never a change to the flow's grading logic itself. With the rule off, the namesake article
    // becomes a real candidate, so the discovery stage's "namesake never became a candidate" check
    // must go red, proving the flow does not pass regardless of what actually happened.
    const dir = mkdtempSync(join(tmpdir(), 'exhibit-flow-tamper-'));
    try {
      const report = await runFlow({ outDir: dir, ruleOptions: { disabled: ['X-second-identifier'] } });
      const discovery = report.stages.find((s) => s.id === 'discovery')!;
      expect(discovery.pass).toBe(false);
      expect(report.ok).toBe(false);
      expect(report.passed).toBeLessThan(report.total);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
