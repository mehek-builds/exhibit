import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DARA } from '../harness/corpus.js';
import { createHarnessEnv } from '../harness/env.js';
import { runScenarioAttempt } from '../harness/runner.js';
import type { FakeArga } from './arga-fake.js';
import { installNetworkGuard, startFakeArga } from './arga-fake.js';

// Proves harness/runner.ts's backend selection: the default memory path is unchanged, `--backend
// arga` without a key fails fast and never falls back to memory, and S2 runs end to end against
// test/arga-fake.ts (the same local stand-in for the Arga control plane and Google twins that
// test/arga-backend.test.ts uses), reports backend 'arga', and reuses one saved Arga scenario
// across attempts. A network guard blocks every non-loopback request.

describe('runScenarioAttempt: default backend (memory) is unchanged', () => {
  it('produces the same checks/pass result as calling createHarnessEnv directly for S2', async () => {
    const { scenarios } = await import('../harness/scenarios.js');
    const s2 = scenarios().find((s) => s.id === 'S2')!;

    const direct = createHarnessEnv({ seed: s2.seed(), profile: s2.profile, gate: s2.gate ?? 'mcp', twinOptions: s2.twinOptions, features: s2.features, scenarioId: s2.id, attempt: 1, ...s2.env });
    await s2.play({ env: direct });
    const directChecks = await s2.grade({ env: direct });
    await direct.close();

    const viaRunner = await runScenarioAttempt(s2, 1);

    expect(viaRunner.metrics?.backend).toBe('memory');
    expect(viaRunner.checks.map((c) => ({ name: c.name, pass: c.pass }))).toEqual(directChecks.map((c) => ({ name: c.name, pass: c.pass })));
    expect(viaRunner.passed).toBe(directChecks.length > 0 && directChecks.every((c) => c.pass));
  });

  it('defaults MatrixOptions.backend to memory with no flag passed', async () => {
    const { scenarios } = await import('../harness/scenarios.js');
    const s3 = scenarios().find((s) => s.id === 'S3')!;
    const r = await runScenarioAttempt(s3, 1, {});
    expect(r.metrics?.backend).toBe('memory');
  });
});

describe("runScenarioAttempt: backend 'arga' without a key", () => {
  it('fails fast and never falls back to memory', async () => {
    const { scenarios } = await import('../harness/scenarios.js');
    const s2 = scenarios().find((s) => s.id === 'S2')!;
    const r = await runScenarioAttempt(s2, 1, { backend: 'arga' });
    expect(r.error).toMatch(/argaApiKey|ARGA_API_KEY/);
    expect(r.passed).toBe(false);
    // Never silently graded as if it had run against memory twins.
    expect(r.metrics).toBeUndefined();
  });
});

describe('runScenarioAttempt: backend arga against the fake Arga service', () => {
  let guard: ReturnType<typeof installNetworkGuard>;
  let fake: FakeArga | undefined;
  beforeAll(() => {
    guard = installNetworkGuard();
  });
  afterAll(() => guard.restore());
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
    // Nothing escaped to a real host (an upload aimed at www.googleapis.com, the default Arga host).
    expect(guard.blocked).toEqual([]);
  });

  it('runs S2 end to end on the hosted-twin path and reports backend arga with every check passing', async () => {
    fake = await startFakeArga({ owner: DARA.emails[0]! });
    const { scenarios } = await import('../harness/scenarios.js');
    const s2 = scenarios().find((s) => s.id === 'S2')!;

    const r = await runScenarioAttempt(s2, 1, { backend: 'arga', argaApiKey: 'arga_sk_test', argaBaseUrl: fake.url });

    expect(r.error).toBeUndefined();
    expect(r.metrics?.backend).toBe('arga');
    expect(r.checks.map((c) => `${c.name}: ${c.pass ? 'pass' : `FAIL ${c.detail}`}`)).toEqual(['candidate found: pass', 'status qualifying: pass', 'criteria {1,2}: pass', 'exactly one exhibit: pass']);
    expect(r.sideEffects).toEqual([]);
    expect(r.runs.map((run) => run.outcome)).not.toContain('degraded');
    expect(r.passed).toBe(true);

    // The agent really worked through the twins: seed mail read from Gmail, the binder filed to
    // Drive through multipart uploads that landed on the fake (not www.googleapis.com), and the
    // review sheet and scorecard doc created in the shared Workspace store.
    expect(fake.state.requests.some((q) => q.twin === 'gmail' && q.method === 'GET' && q.path.includes('format=raw'))).toBe(true);
    expect(fake.state.requests.filter((q) => q.twin === 'google_drive' && q.method === 'POST' && q.path.startsWith('/upload/drive/v3/files')).length).toBeGreaterThan(0);
    expect(fake.state.requests.some((q) => q.twin === 'google_sheets' && q.method === 'POST' && q.path === '/v4/spreadsheets')).toBe(true);
    expect(fake.state.rejectedAuth).toEqual([]);
    // The environment was torn down on close.
    expect(fake.state.calls.delete).toBe(1);
    expect(fake.state.envExists).toBe(false);
  });

  it('reuses the same Arga scenario id on attempt 2 and tears each environment down', async () => {
    fake = await startFakeArga({ owner: DARA.emails[0]! });
    const { scenarios } = await import('../harness/scenarios.js');
    const s2 = scenarios().find((s) => s.id === 'S2')!;

    const r1 = await runScenarioAttempt(s2, 1, { backend: 'arga', argaApiKey: 'arga_sk_test', argaBaseUrl: fake.url });
    const r2 = await runScenarioAttempt(s2, 2, { backend: 'arga', argaApiKey: 'arga_sk_test', argaBaseUrl: fake.url });

    expect(r1.error).toBeUndefined();
    expect(r2.error).toBeUndefined();
    expect(r1.passed).toBe(true);
    expect(r2.passed).toBe(true);
    // One saved scenario: attempt 1 looked it up by name and created it, attempt 2 was handed its id.
    expect(fake.state.scenarios).toHaveLength(1);
    expect(fake.state.calls.create).toBe(1);
    expect(fake.state.calls.list).toBe(1);
    expect(fake.state.calls.ensure).toBe(2);
    expect(fake.state.calls.delete).toBe(2);
    expect(fake.state.calls.reseed).toBe(0);
  });
});
