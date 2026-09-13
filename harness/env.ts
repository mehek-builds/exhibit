import type { AgentDeps, AgentExtension, RunSummary } from '../src/agent.js';
import type { GmailMessage, TwilioApi } from '../src/apps/types.js';
import type { StructuredResearch } from '../src/integrations/types.js';
import { runExhibit } from '../src/agent.js';
import { Ledger } from '../src/ledger.js';
import type { WorthSendingGate } from '../src/letters/worthSending.js';
import { LibraryWorthSendingGate, McpWorthSendingGate, UnavailableGate } from '../src/letters/worthSending.js';
import { AnthropicModel } from '../src/models/anthropic.js';
import { HeuristicModel } from '../src/models/heuristic.js';
import type { EvidenceModel } from '../src/models/types.js';
import { LocalTracer } from '../src/observability/tracer.js';
import { sourcePolicy } from '../src/research/corroborator.js';
import { FixtureFetcher, FixtureResearcher } from '../src/research/fixture.js';
import type { RuleOptions } from '../src/rules/explicit.js';
import type { PromptGraph } from '../src/rules/graph.js';
import { loadGraph } from '../src/rules/graph.js';
import type { TwinOp, TwinOptions, TwinSeed } from '../src/twins/memory.js';
import { MemoryTwins } from '../src/twins/memory.js';
import type { FounderProfile } from '../src/types.js';
// Type-only: TwinsState is the MemoryTwins-shaped state() return both backends produce
// (harness/arga-backend.ts). `import type` is erased, so this doesn't create a runtime cycle even
// though arga-backend.ts imports values (defaultModel, graph) from this file.
import type { TwinsState } from './arga-backend.js';
import { DARA, NOW } from './corpus.js';
import { WEB_FIXTURES } from './fixtures.js';

/** Gmail message shape the harness's admin surface accepts (matches MemoryTwins.adminAddMessage and
 * ArgaTwinsAdapter.adminAddMessage exactly). */
type AdminGmailMessage = Omit<GmailMessage, 'id' | 'raw' | 'labels' | 'headers' | 'threadId'> &
  Partial<Pick<GmailMessage, 'threadId' | 'headers' | 'labels'>>;

/**
 * Structural surface both MemoryTwins (src/twins/memory.ts) and ArgaTwinsAdapter
 * (harness/arga-backend.ts) satisfy, so harness/runner.ts, harness/grade.ts and harness/scenarios.ts
 * work unchanged against either backend. `recordOp` stays required (harness/presets.ts and several
 * scenarios call it unconditionally on `env.twins`); `extend` is optional since nothing calls
 * `env.twins.extend()` through this interface today (only AgentDeps.extend, which each backend wires
 * separately). Admin methods return `void | Promise<void>` because MemoryTwins's are synchronous and
 * ArgaTwinsAdapter's are async -- callers never use the return value.
 */
export interface TwinsHandle {
  readonly backend?: string;
  ops: TwinOp[];
  stubHits: string[];
  state(): TwinsState;
  drivePath(fileId: string): string;
  driveContent(fileId: string): Uint8Array | null;
  recordOp(app: string, op: string, actor: TwinOp['actor'], detail: Record<string, unknown>): void;
  extend?(): Promise<void>;
  /** Hosted twins only: waits for queued world actions to land, then re-reads state. Scenarios call
   * the admin* actions without awaiting (they are synchronous in memory). */
  settle?(): Promise<void>;
  adminAddMessage(msg: AdminGmailMessage): unknown;
  adminShareFile(fileId: string, email: string): unknown;
  adminOverwriteFile(fileId: string, content: Uint8Array | string): unknown;
  adminSetSheetCell(spreadsheetId: string, match: { column: string; equals: string }, column: string, value: string): unknown;
}

// One harness environment: in-memory twins seeded for a scenario, a fresh ledger, a local tracer,
// fixture research, and the agent wired to all of them. Shared by the scenario runner and the demo.

export interface HarnessEnvOptions {
  seed: TwinSeed;
  profile?: FounderProfile;
  now?: Date;
  gate?: 'mcp' | 'library' | 'unavailable';
  ruleOptions?: RuleOptions;
  features?: AgentDeps['features'];
  twinOptions?: Partial<Omit<TwinOptions, 'now'>>;
  scenarioId?: string;
  attempt?: number;
  release?: string;
  ledgerPath?: string;
  traceDir?: string | null;
  model?: EvidenceModel;
  /** 6.13/6.14 features for this environment; built after the env exists so they can reach its twins. */
  extensions?: (env: HarnessEnv) => AgentExtension[];
  twilio?: (env: HarnessEnv) => TwilioApi;
  structured?: StructuredResearch;
}

export interface HarnessEnv {
  twins: TwinsHandle;
  ledger: Ledger;
  tracer: LocalTracer;
  gate: WorthSendingGate;
  deps: AgentDeps;
  profile: FounderProfile;
  clock: { now(): Date; set(d: Date): void; advance(ms: number): void };
  runs: RunSummary[];
  run(): Promise<RunSummary>;
  close(): Promise<void>;
}

let cachedGraph: PromptGraph | null = null;
export function graph(): PromptGraph {
  cachedGraph ??= loadGraph();
  return cachedGraph;
}

export function defaultModel(): EvidenceModel {
  if (process.env.EXHIBIT_LIVE_MODEL === '1' && process.env.ANTHROPIC_API_KEY) return new AnthropicModel(process.env.ANTHROPIC_API_KEY, { modelId: process.env.EXHIBIT_MODEL ?? 'claude-sonnet-5', graph: graph() });
  return new HeuristicModel();
}

function makeGate(kind: HarnessEnvOptions['gate']): WorthSendingGate {
  if (kind === 'library') return new LibraryWorthSendingGate();
  if (kind === 'unavailable') return new UnavailableGate();
  return new McpWorthSendingGate();
}

export function createHarnessEnv(o: HarnessEnvOptions): HarnessEnv {
  let now = new Date((o.now ?? NOW).getTime());
  const clock = {
    now: () => new Date(now.getTime()),
    set: (d: Date) => {
      now = new Date(d.getTime());
    },
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
  const profile = o.profile ?? DARA;
  const twins = new MemoryTwins(o.seed, { ...o.twinOptions, now: clock.now });
  const ledger = new Ledger(o.ledgerPath ?? ':memory:');
  const tracer = new LocalTracer(o.traceDir ?? null);
  const gate = makeGate(o.gate);
  const g = graph();
  const deps: AgentDeps = {
    apps: twins.apps,
    ledger,
    tracer,
    profile,
    model: o.model ?? defaultModel(),
    graph: g,
    researcher: new FixtureResearcher(WEB_FIXTURES),
    fetcher: new FixtureFetcher(WEB_FIXTURES),
    policy: sourcePolicy(g, true),
    gate,
    clock,
    release: o.release ?? 'dev',
    extend: () => twins.extend(),
    mode: 'harness',
    scenarioId: o.scenarioId ?? null,
    attempt: o.attempt ?? null,
    ruleOptions: o.ruleOptions,
    features: o.features,
  };
  const runs: RunSummary[] = [];
  const env: HarnessEnv = {
    twins,
    ledger,
    tracer,
    gate,
    deps,
    profile,
    clock,
    runs,
    async run() {
      const runId = `${o.scenarioId ?? 'adhoc'}-a${o.attempt ?? 1}-r${runs.length + 1}`;
      const summary = await runExhibit(deps, { runId });
      runs.push(summary);
      return summary;
    },
    async close() {
      await gate.close();
      ledger.close();
    },
  };
  if (o.twilio) twins.apps.twilio = o.twilio(env);
  if (o.extensions) deps.extensions = o.extensions(env);
  if (o.structured) deps.structured = o.structured;
  return env;
}
