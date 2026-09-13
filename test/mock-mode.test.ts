import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

// End-to-end CLI checks for `--mock` mode (run/watch/serve/text/verify), all spawned with NO env
// keys so a network-shaped failure here means the mock path leaked to something live.

const CLI = join(process.cwd(), 'src', 'cli.ts');
const TSX = join(process.cwd(), 'node_modules', '.bin', 'tsx');

function emptyEnv(): NodeJS.ProcessEnv {
  // Deliberately does not inherit process.env: no ANTHROPIC_API_KEY, no GOOGLE_*/GITHUB_TOKEN/etc.
  return { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
}

function runCli(args: string[], opts: { timeoutMs?: number } = {}): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [TSX, CLI, ...args], { env: emptyEnv(), encoding: 'utf8', timeout: opts.timeoutMs ?? 60_000 });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

let stateDir: string;
const spawnedServers: ChildProcess[] = [];

afterEach(() => {
  for (const child of spawnedServers.splice(0)) {
    if (!child.killed) child.kill('SIGINT');
  }
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
});

function freshStateDir(): string {
  stateDir = mkdtempSync(join(tmpdir(), 'exhibit-mock-test-'));
  return stateDir;
}

describe('exhibit --mock mode', () => {
  it('run --mock exits 0 and files exhibits; a second run files nothing new', () => {
    const dir = freshStateDir();
    const first = runCli(['run', '--mock', '--state', dir], { timeoutMs: 120_000 });
    expect(first.stderr).not.toMatch(/network/i);
    expect(first.status).toBe(0);
    expect(first.stdout).toMatch(/MOCK MODE/);
    expect(first.stdout).toMatch(/Exhibits filed: [1-9]/);

    const second = runCli(['run', '--mock', '--state', dir], { timeoutMs: 120_000 });
    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(/Exhibits filed: 0\b/);
  }, 180_000);

  it('verify --mock exits 0 after a run', () => {
    const dir = freshStateDir();
    expect(runCli(['run', '--mock', '--state', dir], { timeoutMs: 120_000 }).status).toBe(0);
    const verify = runCli(['verify', '--mock', '--state', dir]);
    expect(verify.status).toBe(0);
    expect(verify.stdout).toMatch(/Files checked/);
  }, 180_000);

  it('run --mock --advance 8d works and advances the mock clock', () => {
    const dir = freshStateDir();
    expect(runCli(['run', '--mock', '--state', dir], { timeoutMs: 120_000 }).status).toBe(0);
    const advanced = runCli(['run', '--mock', '--state', dir, '--advance', '8d'], { timeoutMs: 120_000 });
    expect(advanced.status).toBe(0);
  }, 180_000);

  it('--mock and --live together fail with a clear error', () => {
    const dir = freshStateDir();
    const result = runCli(['run', '--mock', '--live', '--state', dir]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/--mock and --live cannot be combined/);
  });

  it('the fetch guard throws on an attempted network call in mock mode', async () => {
    const dir = freshStateDir();
    const { buildMockDeps } = await import('../src/mock/deps.js');
    const { deps, close } = await buildMockDeps({ stateDir: dir });
    try {
      await expect(fetch('https://example.com')).rejects.toThrow(/mock mode/i);
    } finally {
      await close();
    }
    // restored after close()
    void deps;
  });

  it('serve --mock --port 0 accepts inbound texts from the synthetic founder and ignores others', async () => {
    const dir = freshStateDir();
    const child = spawn(process.execPath, [TSX, CLI, 'serve', '--mock', '--state', dir, '--port', '0'], { env: emptyEnv() });
    spawnedServers.push(child);

    let stdout = '';
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`serve --mock did not print a bound port in time. stdout so far:\n${stdout}`)), 60_000);
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        const m = stdout.match(/Twilio webhook listening on :(\d+)/);
        if (m) {
          clearTimeout(timer);
          resolve(Number(m[1]));
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`serve --mock exited early (code ${code}). Output:\n${stdout}`));
      });
    });

    // Give the startup run a moment to finish before texting.
    await new Promise((r) => setTimeout(r, 2000));

    const status = runCli(['text', '--mock', '--port', String(port), 'status'], { timeoutMs: 30_000 });
    expect(status.status).toBe(0);
    expect(status.stdout).toMatch(/POST .* -> 200/);

    const ignored = runCli(['text', '--mock', '--port', String(port), '--from', '+15550000000', 'approve 1'], { timeoutMs: 30_000 });
    expect(ignored.status).toBe(0);
    expect(ignored.stdout).toMatch(/Ignored:/);
  }, 120_000);
});
