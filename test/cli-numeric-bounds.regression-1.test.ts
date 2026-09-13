import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

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

describe('CLI numeric bounds', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    [['eval', '--attempts', '101', '--scenario', 'S2'], /positive integer from 1 to 100/],
    [['eval', '--attempts', '9007199254740992', '--scenario', 'S2'], /positive integer from 1 to 100/],
    [['watch', '--live', '--interval', '59.999'], /must be from 60 to 2147483 seconds/],
    [['watch', '--live', '--interval', '2147484'], /must be from 60 to 2147483 seconds/],
    [['serve', '--interval', '59.999'], /must be from 60 to 2147483 seconds/],
    [['serve', '--interval', '2147484'], /must be from 60 to 2147483 seconds/],
    [['serve', '--port', '0'], /integer from 1 to 65535/],
    [['serve', '--port', '65536'], /integer from 1 to 65535/],
    [['serve', '--port', '3.5'], /integer from 1 to 65535/],
    [['serve', '--port', 'banana'], /integer from 1 to 65535/],
  ])('rejects %j before starting live work', (args, message) => {
    const cwd = mkdtempSync(join(tmpdir(), 'exhibit-cli-bounds-'));
    tempDirs.push(cwd);
    const result = runInvalid(cwd, args as string[]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(message as RegExp);
  });
});
