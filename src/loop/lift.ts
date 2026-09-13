import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuditIssue } from '../observability/audit.js';
import type { MatrixResult } from '../../harness/runner.js';

// The Lemma-to-Arga loop (PRD 12.6, harness/lifted/README.md): a failing input becomes a permanent
// regression scenario. An issue is resolved only when its lifted scenario passes 3 of 3 in the
// latest batch and does not recur, never on a merged fix alone.

export const LIFTED_DIR = join(process.cwd(), 'harness', 'lifted');

interface LiftedGmail {
  id: string;
  from: string;
  to?: string[];
  date: string;
  subject: string;
  body: string;
}

export interface LiftIssueInput {
  issue: AuditIssue | { title: string; detail: string; source: 'harness' | 'lemma' | 'audit' };
  inputs: { gmail: LiftedGmail[] };
  expect: { source: string; status: string; criteria?: number[]; never?: number[] };
  id?: string;
}

function sourceOf(issue: LiftIssueInput['issue']): 'harness' | 'lemma' | 'audit' {
  return 'source' in issue ? issue.source : 'audit';
}

function titleOf(issue: LiftIssueInput['issue']): string {
  return issue.title;
}

function nextLiftedId(dir = LIFTED_DIR): string {
  let max = 18;
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    files = [];
  }
  for (const f of files) {
    const m = /^S(\d+)(?:-.*)?\.json$/.exec(f);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `S${max + 1}`;
}

/**
 * Lift a failing input into the next harness/lifted/S<n>.json (format in harness/lifted/README.md).
 * Returns the written path. The scenario stays in the matrix forever once written -- see the README's
 * "never deleted" rule.
 */
export function liftIssue(input: LiftIssueInput, dir = LIFTED_DIR): string {
  const id = input.id ?? nextLiftedId(dir);
  const record = {
    id,
    title: titleOf(input.issue),
    sourceIssue: `${sourceOf(input.issue)}: ${'detail' in input.issue ? input.issue.detail : ''}`.trim(),
    createdAt: new Date().toISOString(),
    gmail: input.inputs.gmail,
    expect: input.expect,
  };
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.json`);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

export interface LoopStatusRow {
  scenarioId: string;
  title: string;
  attempts: number;
  passed: number;
  closed: boolean;
}

/**
 * Per lifted scenario in the latest batch: attempts, passed, and whether it closed (3 of 3, per
 * the founder's loop rule -- a scenario id starting S19 or above is treated as lifted, matching
 * cmdLift's numbering, which starts new scenarios at S19).
 */
export function loopStatus(matrix: MatrixResult): LoopStatusRow[] {
  return matrix.stats
    .filter((s) => /^S(\d+)$/.test(s.scenarioId) && Number(/^S(\d+)$/.exec(s.scenarioId)![1]) >= 19)
    .map((s) => ({ scenarioId: s.scenarioId, title: s.title, attempts: s.attempts, passed: s.passed, closed: s.attempts === 3 && s.passed === 3 }));
}
