import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MatrixResult } from '../../harness/runner.js';
import { detectorLabels } from '../loop/detector.js';
import { loopStatus } from '../loop/lift.js';
import { recordRuleChange } from '../loop/ruleChanges.js';
import type { RuleChangeRow } from '../loop/ruleChanges.js';

// `exhibit loop` and `exhibit rule-change` (PRD 12.6): the reviewer wires these into src/cli.ts.
// loop prints where every lifted scenario stands and how the local audit's issues would score
// against the audit's precision/recall bar; rule-change appends one durable row for the brief's
// section 8.

const REPORTS_DIR = join(process.cwd(), 'reports');

/** Reads reports/eval-latest.json (written by `exhibit eval`) and prints loopStatus + detectorLabels. */
export function cmdLoop(_args: string[], reportsDir = REPORTS_DIR): number {
  const path = join(reportsDir, 'eval-latest.json');
  if (!existsSync(path)) {
    console.error(`No ${path} found. Run \`exhibit eval\` first.`);
    return 1;
  }
  const matrix = JSON.parse(readFileSync(path, 'utf8')) as MatrixResult;

  const status = loopStatus(matrix);
  console.log('Lifted scenario | attempts | passed | closed');
  if (status.length === 0) console.log('  (none lifted yet)');
  for (const s of status) console.log(`  ${s.scenarioId} ${s.title} | ${s.attempts} | ${s.passed} | ${s.closed ? 'CLOSED' : 'open'}`);

  const labels = detectorLabels(matrix);
  console.log('');
  console.log(`Detector labels (${labels.source}): correct=${labels.counts.correct} false_alarm=${labels.counts.false_alarm} expected_catch=${labels.counts.expected_catch} missed=${labels.counts.missed}`);

  return 0;
}

/** Appends one row to prompts/rule-changes.json (PRD 7.4, 12.6 section 8 of the brief). */
export function cmdRuleChange(row: RuleChangeRow, path?: string): RuleChangeRow[] {
  const log = recordRuleChange(row, path);
  console.log(`Recorded rule change for fragment ${row.fragment} (${row.result}).`);
  return log;
}
