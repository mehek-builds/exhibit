import { describe, expect, it } from 'vitest';
import { runMatrix } from '../harness/runner.js';

// Every core Arga scenario, once each (PRD 12.2, 12.3). Attempts are kept at 1 here for speed; the
// full 3-attempt matrix runs out of band (npm script / CI job).
//
// The mutation check itself (mutationCheck()) is NOT re-run here: test/mutation.test.ts already
// asserts `m.killed` for every mutation this function returns (a strict superset of what used to
// run here as "kills both mutations"), so running it again in this file only duplicated ~3-4
// minutes of work per full suite run without adding coverage.

describe('Arga core scenarios', () => {
  it(
    'passes every core scenario',
    async () => {
      const result = await runMatrix({ core: true, attempts: 1 });
      const failing = result.attempts.filter((a) => !a.passed);
      if (failing.length) {
        const report = failing
          .map((a) => {
            const badChecks = a.checks.filter((c) => !c.pass).map((c) => `    - ${c.name}: ${c.detail}`);
            const badSide = a.sideEffects.map((s) => `    - side effect ${s.kind}: ${s.detail}`);
            return [`${a.scenarioId} (${a.title}) attempt ${a.attempt}${a.error ? ` ERROR: ${a.error}` : ''}`, ...badChecks, ...badSide].join('\n');
          })
          .join('\n');
        console.error(`Failing core scenarios:\n${report}`);
      }
      expect(failing, `failing core scenarios:\n${failing.map((a) => a.scenarioId).join(', ')}`).toHaveLength(0);
      expect(result.allCorePassed).toBe(true);
    },
    240_000,
  );
});
