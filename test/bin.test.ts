import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

// bin/exhibit.mjs (PRD: launches src/cli.ts via tsx from any cwd, forwards args/exit codes).

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const binPath = join(repoRoot, 'bin', 'exhibit.mjs');

function runFrom(cwd: string, args: string[]) {
  try {
    const stdout = execFileSync(process.execPath, [binPath, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout };
  } catch (err: any) {
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('bin/exhibit.mjs', () => {
  it('runs the CLI from the repo root', () => {
    const result = runFrom(repoRoot, ['help']);
    expect(result.status).toBe(0);
  });

  it('runs the CLI from an unrelated working directory (paths resolve relative to the bin file, not cwd)', () => {
    const result = runFrom(tmpdir(), ['help']);
    expect(result.status).toBe(0);
  });

  it('forwards a nonzero exit code for an unknown command', () => {
    const result = runFrom(repoRoot, ['this-command-does-not-exist']);
    expect(result.status).not.toBe(0);
  });
});
