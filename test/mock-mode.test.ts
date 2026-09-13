import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import type { MockState } from '../src/mock/deps.js';

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

    // Wait for the startup run to finish (it queues the figures the founder can approve) before texting.
    const startupDeadline = Date.now() + 90_000;
    while (!/\[startup\]/.test(stdout) && Date.now() < startupDeadline) await new Promise((r) => setTimeout(r, 250));
    expect(stdout).toMatch(/\[startup\]/);

    // The founder's text reaches the text channel and gets a real reply, not just an HTTP 200.
    const status = runCli(['text', '--mock', '--port', String(port), 'status'], { timeoutMs: 40_000 });
    expect(status.status).toBe(0);
    expect(status.stdout).toMatch(/POST .* -> 200/);
    expect(status.stdout).toMatch(/Reply:/);

    // A founder command actually changes state: approving figure 1 is acknowledged in the reply.
    const approve = runCli(['text', '--mock', '--port', String(port), 'approve 1'], { timeoutMs: 40_000 });
    expect(approve.status).toBe(0);
    expect(approve.stdout).toMatch(/Reply:[\s\S]*approv/i);

    // Any other number is dropped (constraint 15): no reply is produced for it.
    const ignored = runCli(['text', '--mock', '--port', String(port), '--from', '+15550000000', 'approve 1'], { timeoutMs: 30_000 });
    expect(ignored.status).toBe(0);
    expect(ignored.stdout).toMatch(/Ignored:/);
    expect(ignored.stdout).not.toMatch(/Reply:/);
  }, 120_000);

  // The simulated nightly upgrade job (PRD E63) and the persisted fake chain (harness/fixtures/integrity.ts,
  // src/mock/deps.ts): a proof stamped on one `run --mock` invocation upgrades on the next, and `verify --mock`
  // can see that confirmation from a brand-new process because the fake chain is saved in mock-state.json.
  it('a second run --mock confirms proofs the first stamped, and verify --mock catches tampering', () => {
    const dir = freshStateDir();

    // Run 1: stamps every stampable artifact. Nothing can have confirmed yet.
    const run1 = runCli(['run', '--mock', '--state', dir], { timeoutMs: 120_000 });
    expect(run1.status).toBe(0);

    const verify1 = runCli(['verify', '--mock', '--state', dir]);
    expect(verify1.status).toBe(0);
    expect(verify1.stdout).toMatch(/confirmed:\s+0/);
    expect(verify1.stdout).toMatch(/pending:\s+[1-9]/);
    expect(verify1.stdout).toMatch(/failed:\s+0/);

    // Run 2: buildMockDeps sees an existing snapshot, so it calls markUpgraded() before this run,
    // upgrading every proof run 1 stamped, and saves their fake heights/roots to mock-state.json.
    const run2 = runCli(['run', '--mock', '--state', dir], { timeoutMs: 120_000 });
    expect(run2.status).toBe(0);

    const stateAfterRun2 = JSON.parse(readFileSync(join(dir, 'mock-state.json'), 'utf8')) as MockState;
    expect(Object.keys(stateAfterRun2.chainRoots ?? {}).length).toBeGreaterThan(0);

    const verify2 = runCli(['verify', '--mock', '--state', dir]);
    expect(verify2.status).toBe(0);
    expect(verify2.stdout).toMatch(/confirmed:\s+[1-9]/);
    expect(verify2.stdout).toMatch(/pending:\s+0\b/);
    expect(verify2.stdout).toMatch(/failed:\s+0/);
    const confirmedAfterRun2 = Number(verify2.stdout.match(/confirmed:\s+(\d+)/)?.[1]);

    // Tamper with one filed artifact's bytes directly in the saved mock state (the Drive twin's
    // snapshot stores each file's content as base64 -- see MemoryTwins.snapshot()/restore()).
    const state = JSON.parse(readFileSync(join(dir, 'mock-state.json'), 'utf8')) as MockState;
    const stampableRoles = new Set(['original', 'render', 'member', 'signed_letter', 'translation']);
    const target = state.twins.drive.find((f) => stampableRoles.has(f.meta.appProperties?.role ?? ''));
    expect(target).toBeTruthy();
    const targetName = target!.meta.name;
    const original = Buffer.from(target!.content, 'base64');
    const tampered = Buffer.from(original);
    tampered[0] = (tampered[0]! + 1) % 256;
    target!.content = tampered.toString('base64');
    writeFileSync(join(dir, 'mock-state.json'), `${JSON.stringify(state, null, 2)}\n`);

    const verifyTampered = runCli(['verify', '--mock', '--state', dir]);
    expect(verifyTampered.status).toBe(1);
    expect(verifyTampered.stdout).toMatch(/FAILED/);
    expect(verifyTampered.stdout).toContain(targetName);

    // Restore the untampered bytes before the third run so filing/stamping stays consistent.
    target!.content = original.toString('base64');
    writeFileSync(join(dir, 'mock-state.json'), `${JSON.stringify(state, null, 2)}\n`);

    // Run 3: no new data, so nothing new to stamp; everything already confirmed stays confirmed with
    // no duplicate stamps (the `ots:<fileId>` kv guard in src/integrity/extension.ts `stampFile`).
    const run3 = runCli(['run', '--mock', '--state', dir], { timeoutMs: 120_000 });
    expect(run3.status).toBe(0);

    const verify3 = runCli(['verify', '--mock', '--state', dir]);
    expect(verify3.status).toBe(0);
    expect(verify3.stdout).toMatch(/failed:\s+0/);
    expect(verify3.stdout).toMatch(new RegExp(`confirmed:\\s+${confirmedAfterRun2}\\b`));
  }, 240_000);
});
