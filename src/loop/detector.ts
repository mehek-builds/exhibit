import type { MatrixResult } from '../../harness/runner.js';

// Detector labels for the trace audit's precision/recall (PRD 12.4, 12.6: audit issues raised, by
// mode; fixed; recurred or not; each issue labeled correct or false, and each graded failure the
// audit did not raise is a miss). Arga knows the right answer for every scenario, so each issue
// from src/observability/audit.ts can be checked against the grader's own failed checks and side
// effects.

export type DetectorLabel = 'correct' | 'false_alarm' | 'expected_catch' | 'missed';

export interface DetectorRow {
  scenarioId: string;
  attempt: number;
  label: DetectorLabel;
  issueTitle: string | null;
  failureDetail: string | null;
}

export interface DetectorSummary {
  source: 'local-audit';
  counts: Record<DetectorLabel, number>;
  rows: DetectorRow[];
}

// S17 seeds a figure hallucination on purpose to prove the snapshot check catches it (PRD 12.4
// row "Hallucination"); an issue raised there on an otherwise-passing attempt is the system
// working, not a false alarm.
const EXPECTED_CATCH_SCENARIOS = new Set(['S17']);

export function detectorLabels(matrix: MatrixResult): DetectorSummary {
  const rows: DetectorRow[] = [];

  for (const a of matrix.attempts) {
    const failed = a.checks.filter((c) => !c.pass);
    const hasFailure = failed.length > 0 || a.sideEffects.length > 0;
    const issues = a.issues;

    if (issues.length === 0 && hasFailure) {
      const detail = failed[0]?.detail ?? a.sideEffects[0]?.detail ?? 'graded failure';
      rows.push({ scenarioId: a.scenarioId, attempt: a.attempt, label: 'missed', issueTitle: null, failureDetail: detail });
      continue;
    }

    for (const issue of issues) {
      if (hasFailure) {
        rows.push({ scenarioId: a.scenarioId, attempt: a.attempt, label: 'correct', issueTitle: issue.title, failureDetail: failed[0]?.detail ?? a.sideEffects[0]?.detail ?? null });
      } else if (EXPECTED_CATCH_SCENARIOS.has(a.scenarioId) && issue.mode === 'hallucination') {
        rows.push({ scenarioId: a.scenarioId, attempt: a.attempt, label: 'expected_catch', issueTitle: issue.title, failureDetail: null });
      } else {
        rows.push({ scenarioId: a.scenarioId, attempt: a.attempt, label: 'false_alarm', issueTitle: issue.title, failureDetail: null });
      }
    }
  }

  const counts: Record<DetectorLabel, number> = { correct: 0, false_alarm: 0, expected_catch: 0, missed: 0 };
  for (const r of rows) counts[r.label] += 1;

  return { source: 'local-audit', counts, rows };
}
