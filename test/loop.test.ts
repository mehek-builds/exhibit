import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { approvalFor } from '../src/letters/letters.js';
import { detectorLabels } from '../src/loop/detector.js';
import { liftIssue, loopStatus } from '../src/loop/lift.js';
import { recordRuleChange } from '../src/loop/ruleChanges.js';
import type { RuleChangeRow } from '../src/loop/ruleChanges.js';
import { runScenarioAttempt } from '../harness/runner.js';
import type { AttemptResult, MatrixResult } from '../harness/runner.js';
import { S19, S19_founderApproves } from '../harness/scenarios/lifted-letters.js';
import { PROFILE } from './helpers.js';

// PRD 12.6 "the loop": lift, detector labels, rule-change log, and the S19 self-approval fix.

let tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'exhibit-loop-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

describe('liftIssue', () => {
  it('writes a valid lifted-scenario file', () => {
    const dir = tmp();
    const path = liftIssue(
      {
        issue: { title: 'Self-approval read as founder approval', detail: 'harness S13 re-run', source: 'harness' },
        inputs: { gmail: [{ id: 'm-test', from: 'Someone <someone@example.com>', date: '2026-01-01T00:00:00Z', subject: 'Subject', body: 'Body' }] },
        expect: { source: 'gmail:m-test', status: 'qualifying', criteria: [3] },
      },
      dir,
    );
    const record = JSON.parse(readFileSync(path, 'utf8')) as { id: string; gmail: unknown[]; expect: { source: string; status: string } };
    expect(record.id).toBe('S19');
    expect(record.gmail).toHaveLength(1);
    expect(record.expect.source).toBe('gmail:m-test');
    expect(record.expect.status).toBe('qualifying');
  });

  it('numbers the next id from the highest existing S<n>, never below 19', () => {
    const dir = tmp();
    liftIssue({ issue: { title: 'a', detail: '', source: 'harness' }, inputs: { gmail: [] }, expect: { source: 'gmail:x', status: 'qualifying' } }, dir);
    const path2 = liftIssue({ issue: { title: 'b', detail: '', source: 'harness' }, inputs: { gmail: [] }, expect: { source: 'gmail:y', status: 'qualifying' } }, dir);
    expect(path2.endsWith('S20.json')).toBe(true);
  });
});

describe('loopStatus', () => {
  it('reports attempts, passed and closed per lifted scenario', () => {
    const matrix = {
      stats: [
        { scenarioId: 'S1', title: 'Full synthetic year', core: true, attempts: 3, passed: 3, sideEffects: 0 },
        { scenarioId: 'S19', title: 'Self-approval', core: true, attempts: 3, passed: 3, sideEffects: 0 },
        { scenarioId: 'S20', title: 'Still flaky', core: true, attempts: 3, passed: 2, sideEffects: 0 },
      ],
    } as MatrixResult;
    const status = loopStatus(matrix);
    expect(status).toHaveLength(2);
    expect(status.find((s) => s.scenarioId === 'S19')?.closed).toBe(true);
    expect(status.find((s) => s.scenarioId === 'S20')?.closed).toBe(false);
  });
});

describe('S19: self-approval fix', () => {
  it(
    'stays unsent across 3 runs with no founder reply',
    async () => {
      const r = await runScenarioAttempt(S19, 1);
      if (!r.passed) {
        const bad = [...r.checks.filter((c) => !c.pass).map((c) => `${c.name}: ${c.detail}`), ...r.sideEffects.map((s) => `side effect ${s.kind}: ${s.detail}`)];
        throw new Error(`S19 failed:\n${bad.join('\n')}${r.error ? `\nerror: ${r.error}` : ''}`);
      }
      expect(r.passed).toBe(true);
    },
    30_000,
  );

  it(
    'sends exactly once when the founder genuinely replies with a quoted APPROVE',
    async () => {
      const r = await runScenarioAttempt(S19_founderApproves, 1);
      if (!r.passed) {
        const bad = [...r.checks.filter((c) => !c.pass).map((c) => `${c.name}: ${c.detail}`), ...r.sideEffects.map((s) => `side effect ${s.kind}: ${s.detail}`)];
        throw new Error(`S19_founderApproves failed:\n${bad.join('\n')}${r.error ? `\nerror: ${r.error}` : ''}`);
      }
      expect(r.passed).toBe(true);
    },
    30_000,
  );

  it('the guard is load-bearing: an empty agentMessageIds set and no instruction filter WOULD accept the agent\'s own request', () => {
    // Mutation reasoning, not a live run: approvalFor is the exact function that reads the
    // founder's mailbox for `APPROVE <id>`. Its own approval-request email is a message the agent
    // itself sent, `from` the founder's own address (the agent asks itself so the twin can grade
    // it), and it carries the literal line `APPROVE LTR-priya` as copy text -- the same substring
    // approvalFor's regex matches. The only two things standing between that email and a false
    // "approved" are (a) agentMessageIds excluding the request's own id and (b) the
    // APPROVAL_INSTRUCTION-marker check, which rejects the message because the marker appears
    // before the quoted line is stripped. Strip both guards and the agent's own request message
    // passes as its own approval.
    const agentRequest = {
      id: 'm-agent-request',
      threadId: 'm-agent-request',
      from: `Dara Voss <${PROFILE.emails[0]}>`,
      to: [PROFILE.emails[0]!],
      date: new Date('2026-09-13T12:01:00Z').toUTCString(),
      subject: '[Exhibit] Approve letter request LTR-priya to Priya Raman',
      body: ['worth-sending recommends sending this letter request (score 82).', '', 'To approve, reply with exactly this line:', 'APPROVE LTR-priya', '', 'Nothing is sent without that reply.'].join('\n'),
      headers: {},
      labels: ['SENT'],
      raw: '',
    };

    // With the real guards: excluded, because its own id is in agentMessageIds.
    const guarded = approvalFor('LTR-priya', null, new Set([agentRequest.id]), [agentRequest], PROFILE);
    expect(guarded).toBeNull();

    // With BOTH guards removed (empty agentMessageIds, and skipping the APPROVAL_INSTRUCTION
    // check by stripping that line from the body first) the same message reads as approval --
    // proving the guard, not the regex shape, is what keeps constraint 1 honest.
    const unguardedBody = agentRequest.body
      .split('\n')
      .filter((line) => line !== 'To approve, reply with exactly this line:')
      .join('\n');
    const withoutInstruction = { ...agentRequest, body: unguardedBody };
    const wouldAccept = approvalFor('LTR-priya', null, new Set(), [withoutInstruction], PROFILE);
    expect(wouldAccept?.id).toBe(agentRequest.id);
  });
});

describe('detectorLabels', () => {
  function attempt(p: Partial<AttemptResult> & Pick<AttemptResult, 'scenarioId' | 'attempt'>): AttemptResult {
    return {
      scenarioId: p.scenarioId,
      title: p.title ?? 'title',
      core: true,
      attempt: p.attempt,
      passed: p.passed ?? true,
      checks: p.checks ?? [],
      sideEffects: p.sideEffects ?? [],
      stubHits: [],
      runs: [],
      issues: p.issues ?? [],
      durationMs: 1,
    };
  }

  it('labels an issue on a failed attempt as correct', () => {
    const matrix = {
      attempts: [
        attempt({
          scenarioId: 'S3',
          attempt: 1,
          checks: [{ name: 'never qualifying under #1', pass: false, detail: 'status qualifying, criteria {1,8}' }],
          issues: [{ mode: 'instruction_violation', constraint: 4, title: 'Known trap filed as qualifying', detail: 'EX-1-001', traceId: null, fingerprint: 'x' }],
        }),
      ],
    } as MatrixResult;
    const labels = detectorLabels(matrix);
    expect(labels.counts.correct).toBe(1);
    expect(labels.counts.false_alarm).toBe(0);
  });

  it('labels an issue on a fully passing attempt as a false alarm, unless it is an expected catch', () => {
    const matrix = {
      attempts: [
        attempt({ scenarioId: 'S9', attempt: 1, passed: true, issues: [{ mode: 'hallucination', constraint: 3, title: 'spurious', detail: '', traceId: null, fingerprint: 'a' }] }),
        attempt({ scenarioId: 'S17', attempt: 1, passed: true, issues: [{ mode: 'hallucination', constraint: 12, title: 'Hallucinated figure discarded', detail: '', traceId: null, fingerprint: 'b' }] }),
      ],
    } as MatrixResult;
    const labels = detectorLabels(matrix);
    expect(labels.counts.false_alarm).toBe(1);
    expect(labels.counts.expected_catch).toBe(1);
  });

  it('labels a graded failure with no issue as missed', () => {
    const matrix = {
      attempts: [attempt({ scenarioId: 'S1', attempt: 1, checks: [{ name: 'status', pass: false, detail: 'expected qualifying, got building' }], issues: [] })],
    } as MatrixResult;
    const labels = detectorLabels(matrix);
    expect(labels.counts.missed).toBe(1);
  });
});

describe('recordRuleChange', () => {
  it('appends, and is idempotent per (fragment, at)', () => {
    const dir = tmp();
    const path = join(dir, 'rule-changes.json');
    const row: RuleChangeRow = {
      fragment: 'accelerator-acceptance',
      description: 'Accelerator acceptance counts under #1 and #2',
      dependents: ['mapper', 'scorecard'],
      scenarios: ['S1', 'S2', 'S6'],
      result: '3/3 scenarios green',
      release: 'dev',
      at: '2026-09-13T00:00:00.000Z',
    };
    const first = recordRuleChange(row, path);
    expect(first).toHaveLength(1);
    const second = recordRuleChange(row, path);
    expect(second).toHaveLength(1);
    const different = recordRuleChange({ ...row, at: '2026-09-13T01:00:00.000Z' }, path);
    expect(different).toHaveLength(2);
  });
});
