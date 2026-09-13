import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Affected, PromptGraph } from '../rules/graph.js';
import { affected } from '../rules/graph.js';
import type { MatrixResult } from '../../harness/runner.js';

// The durable rule-change log the reliability brief's section 8 reads (PRD 7.4, 12.6). The
// in-memory ledger a run builds does not survive the process, so every merge-worthy change is
// appended here -- one row, never rewritten once written.

export const RULE_CHANGES_PATH = join(process.cwd(), 'prompts', 'rule-changes.json');

export interface RuleChangeRow {
  fragment: string;
  description: string;
  dependents: string[];
  scenarios: string[];
  result: string;
  release: string;
  at: string;
}

function readLog(path: string): RuleChangeRow[] {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as RuleChangeRow[]) : [];
}

/** Append one row, idempotent per (fragment, at): re-appending the same change at the same
 * timestamp is a no-op rather than a duplicate row. */
export function recordRuleChange(row: RuleChangeRow, path = RULE_CHANGES_PATH): RuleChangeRow[] {
  const log = readLog(path);
  const dup = log.some((r) => r.fragment === row.fragment && r.at === row.at);
  const next = dup ? log : [...log, row];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** Build the row for a proved fragment change (post prove-rules, PRD 7.4): dependents from the
 * graph, and the pass rate for each affected scenario read off the matrix that just ran. */
export function ruleChangeFromProof(graph: PromptGraph, fragmentsChanged: string[], matrix: MatrixResult, opts: { description: string; at?: string } = { description: '' }): RuleChangeRow {
  const a: Affected = affected(graph, fragmentsChanged);
  const statsFor = (id: string) => matrix.stats.find((s) => s.scenarioId === id);
  const allPassed = a.scenarios.every((id) => {
    const s = statsFor(id);
    return !!s && s.attempts > 0 && s.passed === s.attempts;
  });
  return {
    fragment: fragmentsChanged.join(','),
    description: opts.description,
    dependents: a.prompts,
    scenarios: a.scenarios,
    result: allPassed ? `${a.scenarios.length}/${a.scenarios.length} scenarios green` : 'not all scenarios green',
    release: matrix.release,
    at: opts.at ?? new Date().toISOString(),
  };
}
