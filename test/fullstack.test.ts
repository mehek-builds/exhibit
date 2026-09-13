import { describe, expect, it } from 'vitest';
import { fullStack, fullStackFeatures, FULL_STACK_EXTENSION_NAMES } from '../harness/presets.js';
import { S25 } from '../harness/scenarios/s25-fullstack.js';
import { runScenarioAttempt } from '../harness/runner.js';
import type { GradeCheck, Scenario } from '../harness/scenarios.js';
import { scenarios as loadScenarios } from '../harness/scenarios.js';
import { knownAnswers } from '../harness/metrics.js';

// The full-stack proof (PRD 6.13, 6.14): S25 once with every extension on, then S1 re-run once per
// extension in isolation, to pin down which extension is at fault if S25 ever goes red for a reason
// S1-alone can't reproduce (constants/hard-constraints.md: no test file may weaken a core check).

function printDiff(label: string, checks: GradeCheck[]): string {
  const failed = checks.filter((c) => !c.pass);
  if (!failed.length) return `${label}: all ${checks.length} checks passed`;
  return [`${label}: ${failed.length}/${checks.length} checks failed`, ...failed.map((c) => `  FAIL ${c.name}: ${c.detail}`)].join('\n');
}

describe('fullStack preset', () => {
  it('features() reports every extension included with no `only` filter', () => {
    const f = fullStackFeatures();
    expect(f.included).toEqual([...FULL_STACK_EXTENSION_NAMES]);
    expect(f.missing).toEqual([]);
  });

  it('opts.only restricts both the build and the features report to the same subset', () => {
    const f = fullStackFeatures({ only: ['discovery', 'integrity'] });
    expect(f.included).toEqual(['discovery', 'integrity']);
    expect(f.missing).toEqual(['text-channel', 'signing', 'translation', 'notifier']);
    const built = fullStack({ only: ['discovery', 'integrity'] });
    expect(built.twilio).toBeUndefined();
  });
});

describe('S25: full stack', () => {
  it('every S1 invariant, idempotency, and side-effect check holds with every 6.13/6.14 extension enabled', async () => {
    const r = await runScenarioAttempt(S25, 1);
    if (r.error) throw new Error(`S25 threw: ${r.error}`);
    // eslint-disable-next-line no-console
    if (!r.passed) console.error(printDiff('S25', r.checks));
    expect(r.checks.length).toBeGreaterThan(0);
    expect(r.checks.filter((c) => !c.pass)).toEqual([]);
    expect(r.sideEffects).toEqual([]);
  }, 60_000);
});

describe('each 6.13/6.14 extension in isolation, S1 known answers intact', () => {
  const s1 = loadScenarios().find((s) => s.id === 'S1')!;

  // "S1 known answers intact" means harness/metrics.ts knownAnswers() (traps/must-count/recall/
  // dates/dual), the same ground-truth scoring S25 re-checks -- not S1's own grade() literally,
  // which asserts an exact candidate count ("exactly 14 qualifying") that is only valid with zero
  // extensions: the discovery extension alone legitimately adds real candidates from its fixtures
  // (a Hugging Face model, patents, podcast episodes, ...), which is expected per PRD 6.14, not a
  // regression. Reusing S1's literal grade() here would fail on that expected, harmless growth.
  for (const name of FULL_STACK_EXTENSION_NAMES) {
    it(`S1 + only(${name}): known answers intact`, async () => {
      const isolated: Scenario = {
        ...s1,
        id: `S1+${name}`,
        env: fullStack({ only: [name] }),
        grade: (ctx) => {
          const ga = knownAnswers(ctx.env);
          const checks: GradeCheck[] = [
            { name: 'traps: zero filed qualifying', pass: ga.trapsFiledQualifying === 0, detail: `${ga.trapsFiledQualifying}/${ga.trapsTotal}` },
            { name: 'must-count: all filed qualifying', pass: ga.mustCountFiledQualifying === ga.mustCountTotal, detail: `${ga.mustCountFiledQualifying}/${ga.mustCountTotal}` },
            { name: 'qualifying recall >= 90%', pass: ga.qualifyingRecall >= 0.9, detail: `${(ga.qualifyingRecall * 100).toFixed(0)}%` },
            { name: 'date accuracy 100%', pass: ga.dateAccuracy === 1, detail: `${ga.dateHit}/${ga.dateTotal}` },
            { name: 'dual status accuracy 100%', pass: ga.dualAccuracy === 1, detail: `${ga.dualHit}/${ga.dualTotal}` },
          ];
          return checks;
        },
      };
      const r = await runScenarioAttempt(isolated, 1);
      if (r.error) throw new Error(`S1+${name} threw: ${r.error}`);
      if (!r.passed) console.error(printDiff(`S1+${name}`, r.checks)); // eslint-disable-line no-console
      expect(r.checks.filter((c) => !c.pass)).toEqual([]);
      expect(r.sideEffects).toEqual([]);
    }, 60_000);
  }
});
