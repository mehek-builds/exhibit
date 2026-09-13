import { describe, expect, it } from 'vitest';
import { mutationCheck, runScenarioAttempt } from '../harness/runner.js';
import { scenarios as loadScenarios } from '../harness/scenarios.js';

// Extends the PRD 12.2 mutation check past D-accelerator-acceptance (S2) and the SAFE rules (S3) to
// the six newer hard-constraint guards: X-second-identifier, TX-verified-number,
// TX-confirm-irreversible, X-sign-both-approvals, X-translation-opt-in and X-integrity-tamper-check.
// Every disabled rule must turn its scenario red (the mutation is "killed"); as a control, the same
// scenarios must still pass with nothing disabled -- proving a broken test setup can't fake a kill.

const CONTROL_SCENARIO_IDS = ['S2', 'S3', 'S20', 'S21', 'S22', 'S23', 'S24'] as const;

describe('mutation check: every guard is load-bearing', () => {
  it(
    'kills every mutation (D-accelerator-acceptance, SAFE rules, second-identifier, verified-number, confirm-irreversible, sign-both-approvals, translation-opt-in, integrity-tamper-check)',
    async () => {
      const { mutations } = await mutationCheck();

      // Sanity: every rule this task adds is represented, plus the two pre-existing ones.
      const expectedRuleIds = [
        'D-accelerator-acceptance',
        'D-funding-remuneration',
        'X-second-identifier',
        'TX-verified-number',
        'TX-confirm-irreversible',
        'X-sign-both-approvals',
        'X-translation-opt-in',
        'X-integrity-tamper-check',
      ];
      for (const id of expectedRuleIds) {
        expect(
          mutations.some((m) => m.disabled.includes(id)),
          `no mutation entry disables ${id}`,
        ).toBe(true);
      }

      for (const m of mutations) {
        expect(m.killed, `${m.name} should have killed ${m.scenario} (detail: ${m.detail})`).toBe(true);
      }
    },
    600_000,
  );

  it(
    'control: the same scenarios still pass with nothing disabled',
    async () => {
      const all = loadScenarios();
      for (const id of CONTROL_SCENARIO_IDS) {
        const scenario = all.find((s) => s.id === id);
        expect(scenario, `${id} not found`).toBeTruthy();
        if (!scenario) continue;
        const r = await runScenarioAttempt(scenario, 1, {});
        expect(r.passed, `${id} should pass with no rules disabled: ${r.error ?? JSON.stringify(r.checks.filter((c) => !c.pass))}`).toBe(true);
      }
    },
    600_000,
  );
});
