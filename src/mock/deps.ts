import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHarnessEnv } from '../../harness/env.js';
import { fullYearSeed, DARA } from '../../harness/corpus.js';
import { fullStack } from '../../harness/presets.js';
import { MemoryTwins } from '../twins/memory.js';
import type { MemoryTwinsSnapshot } from '../twins/memory.js';
import { MemoryTwilio } from '../twins/twilio.js';
import type { MemoryTwilioSnapshot } from '../twins/twilio.js';
import type { AgentDeps } from '../agent.js';
import type { FounderProfile } from '../types.js';

// `--mock` mode (this file): the same in-memory twins, synthetic founder and fixtures the harness
// uses, but wired for repeated CLI invocations against a persisted state directory instead of a
// single in-process run. No live network is ever reachable in mock mode -- see `installFetchGuard`.

export interface FeatureReport {
  id: string;
  enabled: boolean;
  reason: string;
}

export interface MockDepsOptions {
  /** Directory mock state persists in across invocations. Default `.exhibit/mock/`. */
  stateDir?: string;
  /** Override the mock clock's initial value; ignored once a snapshot already exists (its saved clock wins). */
  now?: Date;
}

export interface MockState {
  twins: MemoryTwinsSnapshot;
  twilio: MemoryTwilioSnapshot;
  /** Mock "now", ISO 8601. Advances by real elapsed wall-clock time between invocations, or by `--advance`. */
  nowIso: string;
  /** Wall-clock time (ms since epoch) this snapshot was written, so the next run can add real elapsed time. */
  savedAtMs: number;
}

export interface MockDepsResult {
  deps: AgentDeps;
  env: ReturnType<typeof createHarnessEnv>;
  profile: FounderProfile;
  features: FeatureReport[];
  /** Persists twins + Twilio + clock state to stateDir. Call after every mock run. */
  save(): void;
  /** Restores the real global fetch and closes the ledger/gate. Always call in a `finally`. */
  close(): Promise<void>;
}

function statePath(stateDir: string): string {
  return join(stateDir, 'mock-state.json');
}

function ledgerPath(stateDir: string): string {
  return join(stateDir, 'ledger.db');
}

/**
 * No network in mock mode, ever: every transport the agent uses is a fixture or a fake (see
 * harness/presets.ts `fullStack()`), so any code path that reaches for the real global `fetch`
 * indicates a mock-mode wiring bug rather than an intentional call. Fails loudly instead of quietly
 * hitting the network. Returns a restore function; always call it in `close()`.
 */
export function installFetchGuard(): () => void {
  const globalWithFetch = globalThis as { fetch?: typeof fetch };
  const original = globalWithFetch.fetch;
  const guarded = (async (..._args: Parameters<typeof fetch>): Promise<Response> => {
    throw new Error(
      'Mock mode attempted a real network call via global fetch. Every transport in --mock must be a fixture or fake (harness/presets.ts fullStack()); this is a bug, not an intentional network access.',
    );
  }) as typeof fetch;
  globalWithFetch.fetch = guarded;
  return () => {
    globalWithFetch.fetch = original;
  };
}

function loadState(stateDir: string): MockState | null {
  const path = statePath(stateDir);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as MockState;
}

function saveState(stateDir: string, state: MockState): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(statePath(stateDir), `${JSON.stringify(state, null, 2)}\n`);
}

export function mockFeatures(): FeatureReport[] {
  return [
    { id: 'discovery', enabled: true, reason: 'enabled (mock: fixture transports)' },
    { id: 'text-channel', enabled: true, reason: 'enabled (mock: in-memory Twilio twin)' },
    { id: 'integrity', enabled: true, reason: 'enabled (mock: fixture block headers, no live Bitcoin lookup)' },
    { id: 'signing', enabled: true, reason: 'enabled (mock: fake Dropbox Sign, test/day mode)' },
    { id: 'translation', enabled: true, reason: 'enabled (mock: fake DeepL)' },
    { id: 'notifier', enabled: true, reason: 'enabled' },
    { id: 'structured-research', enabled: true, reason: 'enabled (mock: fixture transports)' },
    { id: 'network', enabled: false, reason: 'disabled: mock mode never reaches the real network' },
  ];
}

export const MOCK_TWILIO_SENDER = 'whatsapp:+15550009999';

/**
 * Builds mock deps: the same fullStack() extensions the harness uses, backed by fixtures/fakes
 * only, seeded from the synthetic founder (DARA) and the full synthetic year (fullYearSeed()) on
 * first use, or restored from `stateDir` on later invocations. Callers own calling `save()` after a
 * run and `close()` in a `finally`.
 */
export async function buildMockDeps(opts: MockDepsOptions = {}): Promise<MockDepsResult> {
  const stateDir = opts.stateDir ?? join(process.cwd(), '.exhibit', 'mock');
  mkdirSync(stateDir, { recursive: true });

  const existing = loadState(stateDir);
  const restoreFetch = installFetchGuard();

  let initialNow: Date;
  if (existing) {
    // Keep the clock plausible across invocations: add real elapsed wall-clock time since the last
    // save, so time-based stages (digest, nudges, freshness) see a clock that moved.
    const elapsed = Math.max(0, Date.now() - existing.savedAtMs);
    initialNow = new Date(new Date(existing.nowIso).getTime() + elapsed);
  } else {
    initialNow = opts.now ?? new Date();
  }

  const env = createHarnessEnv({
    seed: fullYearSeed(),
    profile: DARA,
    now: initialNow,
    gate: 'mcp',
    release: 'mock',
    ledgerPath: ledgerPath(stateDir),
    ...fullStack(),
  });

  if (existing) {
    (env.twins as MemoryTwins).restore(existing.twins);
    const twilio = env.deps.apps.twilio;
    if (twilio instanceof MemoryTwilio) twilio.restore(existing.twilio);
  }

  function save(): void {
    const twins = (env.twins as MemoryTwins).snapshot();
    const twilio = env.deps.apps.twilio;
    const twilioSnapshot = twilio instanceof MemoryTwilio ? twilio.snapshot() : { messages: [], seq: 0 };
    saveState(stateDir, {
      twins,
      twilio: twilioSnapshot,
      nowIso: env.clock.now().toISOString(),
      savedAtMs: Date.now(),
    });
  }

  async function close(): Promise<void> {
    restoreFetch();
    await env.close();
  }

  return {
    deps: env.deps,
    env,
    profile: env.profile,
    features: mockFeatures(),
    save,
    close,
  };
}
