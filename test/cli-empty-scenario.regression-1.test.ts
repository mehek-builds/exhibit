import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, '..', 'bin', 'exhibit.mjs');

describe('empty scenario selection', () => {
  let cwd: string | null = null;

  afterEach(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
    cwd = null;
  });

  it('rejects an empty normalized list without replacing the latest report', () => {
    cwd = mkdtempSync(join(tmpdir(), 'exhibit-empty-scenario-'));
    const reportDir = join(cwd, 'reports');
    const report = join(reportDir, 'eval-latest.json');
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(report, 'known-good-report\n');

    let stderr = '';
    try {
      execFileSync(process.execPath, [binPath, 'eval', '--scenario', ',', '--attempts', '1'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error: any) {
      stderr = String(error.stderr ?? '');
    }

    expect(stderr).toMatch(/--scenario must name at least one scenario/);
    expect(readFileSync(report, 'utf8')).toBe('known-good-report\n');
  });
});
