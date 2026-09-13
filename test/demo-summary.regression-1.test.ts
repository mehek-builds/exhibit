import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { latestEvalSummary } from '../src/demo.js';

let tempDir: string | null = null;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('latestEvalSummary regression', () => {
  it('uses individual attempts when aggregate fields are absent', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'exhibit-demo-summary-'));
    const evalPath = join(tempDir, 'eval.json');
    writeFileSync(
      evalPath,
      JSON.stringify({
        backend: 'memory',
        attempts: [
          { passed: true },
          { passed: true },
          { passed: false },
        ],
      }),
    );

    expect(latestEvalSummary(evalPath)).toBe('2/3 (67%, backend=memory)');
  });

  it('asks for an evaluation when the report is missing or malformed', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'exhibit-demo-summary-'));
    const missingPath = join(tempDir, 'missing.json');
    const malformedPath = join(tempDir, 'malformed.json');
    writeFileSync(malformedPath, '{');

    expect(latestEvalSummary(missingPath)).toBe('run eval');
    expect(latestEvalSummary(malformedPath)).toBe('run eval');
  });

  it('rejects a report from a different release', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'exhibit-demo-summary-'));
    const evalPath = join(tempDir, 'eval.json');
    writeFileSync(evalPath, JSON.stringify({ release: 'oldsha', backend: 'memory', attempts: [{ passed: true }] }));

    expect(latestEvalSummary(evalPath, 'newsha')).toBe('stale evaluation for oldsha; run eval for newsha');
  });
});
