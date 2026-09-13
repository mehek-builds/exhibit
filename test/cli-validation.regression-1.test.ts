import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Regression: ISSUE-002 - invalid eval and graph options produced empty reports or silently changed behavior
// Found by /qa on 2026-09-14
// Report: .gstack/qa-reports/qa-report-localhost-2026-09-14.md

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, '..', 'bin', 'exhibit.mjs');

function runInvalid(cwd: string, args: string[]) {
  try {
    execFileSync(process.execPath, [binPath, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, stderr: '' };
  } catch (error: any) {
    return { status: error.status ?? 1, stderr: String(error.stderr ?? '') };
  }
}

describe('CLI option validation', () => {
  it.each([
    [['eval', '--attempts', '0', '--scenario', 'S2'], /--attempts must be a positive integer/],
    [['eval', '--attempts', 'banana', '--scenario', 'S2'], /--attempts must be a positive integer/],
    [['eval', '--attempts', '1', '--scenario', 'S999'], /Unknown --scenario/],
    [['eval', '--attempts', '1', '--scenario', 'S2', '--gate', 'nonsense'], /Unknown --gate/],
    [['affected', 'not-a-fragment'], /Unknown fragment/],
  ])('rejects %j without replacing the latest valid report', (args, message) => {
    const cwd = mkdtempSync(join(tmpdir(), 'exhibit-cli-validation-'));
    const report = join(cwd, 'reports', 'eval-latest.json');
    mkdirSync(dirname(report), { recursive: true });
    writeFileSync(report, 'known-good-report\n');

    const result = runInvalid(cwd, args as string[]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(message as RegExp);
    expect(readFileSync(report, 'utf8')).toBe('known-good-report\n');
  });
});
