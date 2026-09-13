import { Arga } from 'arga-sdk';
import type { TwinInstance } from 'arga-sdk';
import type { AgentDeps, RunSummary } from '../src/agent.js';
import { runExhibit } from '../src/agent.js';
import type { CalendarEvent, DriveFile, DrivePermission, GmailMessage } from '../src/apps/types.js';
import { TwinExpiredError } from '../src/apps/types.js';
import { Ledger } from '../src/ledger.js';
import type { WorthSendingGate } from '../src/letters/worthSending.js';
import { LibraryWorthSendingGate, McpWorthSendingGate, UnavailableGate } from '../src/letters/worthSending.js';
import type { EvidenceModel } from '../src/models/types.js';
import { LocalTracer } from '../src/observability/tracer.js';
import { sourcePolicy } from '../src/research/corroborator.js';
import { FixtureFetcher, FixtureResearcher } from '../src/research/fixture.js';
import type { RuleOptions } from '../src/rules/explicit.js';
import type { TwinSeed } from '../src/twins/memory.js';
import type { TwinOp } from '../src/twins/memory.js';
import type { FounderProfile } from '../src/types.js';
import { argaApps, extend as argaExtend, fetchAdminState, fetchStubHits } from './arga.js';
import { toArgaSeedConfig } from './arga-seed.js';
import { WEB_FIXTURES } from './fixtures.js';
import { defaultModel, graph } from './env.js';

// Hosted-twin backend for the Arga matrix (PRD 7.1, 12.3, 12.6): the harness environment
// scenarios run against, built once per scenario on real Arga twins instead of src/twins/memory.ts.
//
// SEEDING PATH (confirmed 2026-09-13 from node_modules/arga-sdk/dist/index.d.ts and
// https://docs.argalabs.com/features/custom-scenarios): the installed SDK's `ProvisionTwinsParams`
// (used by `client.twins.provision`) has no `seedConfig` field -- only `scenarioId` /
// `scenarioPrompt` for server-side generation, confirming docs/ARGA.md's original risk #1. But the
// SDK also exposes a `ScenariosResource` (`client.scenarios`) with `create({ name, seedConfig, twins
// })`, `ensureTwinEnvironment(scenarioId)`, `reseedTwinEnvironment(scenarioId)` and
// `deleteTwinEnvironment(scenarioId)`. docs.argalabs.com/features/custom-scenarios confirms
// `seed_config` on scenario creation is real, keyed per twin, e.g. `{"slack": {...}, "stripe":
// {...}}`. This file now seeds through THAT path: create one Arga scenario per Exhibit scenario
// (cached across attempts via `reuseArgaScenarioId`), `ensureTwinEnvironment` to get twin
// base/admin URLs, and `reseedTwinEnvironment` before every attempt after the first to reset to the
// scenario's baseline (replaces the old `twins.reset(runId)` call, which only resets a *disposable*
// `twins.provision` run, not a scenario's long-lived environment).
//
// TWIN NAMES (confirmed 2026-09-13 from https://docs.argalabs.com/concepts/twin-reference): Arga's
// documented identifiers are underscored (`google_calendar`, `google_drive`, `google_docs`,
// `google_sheets`), never hyphenated -- the hyphenated spelling harness/arga.ts also tries is not a
// documented Arga convention. `gmail` IS a real, documented twin (contrary to this file's earlier
// assumption that it might not be). `linkedin` is NOT in Arga's twin catalog at all (checked
// concepts/twin-reference and concepts/digital-twins) -- there is no LinkedIn twin to provision, so
// it is dropped from the default twin set below; LinkedIn scenarios must read from seeded fixtures
// per PRD 7.1's Team-plan fallback, not from an Arga twin.
//
// NO-VACUOUS-PASS GUARD (risk #2): https://docs.argalabs.com/features/twins-quickstart and
// concepts/twin-reference, fetched 2026-09-13, describe `GET <admin_url>/admin/state` per twin but
// document NO operation/audit log field on any Google Workspace or Gmail twin (only GitHub's
// `/admin/stub-hits` and Slack's admin surface are audit-shaped, and neither is a log of writes).
// So `ArgaTwinsAdapter` below no longer assumes `raw.ops` exists. It still reads `raw.ops`
// opportunistically (harmless if absent), but derives side-effect-shaped ops from a state diff
// against a baseline snapshot captured right after provisioning/reseeding -- new Gmail messages
// from the founder's own address, new/changed Drive file content, new Drive permissions, and new
// Calendar/LinkedIn writes. If a twin never returns *any* usable state at all (fetch failed both
// for the baseline and for the post-run read), there is no evidence source -- ops absent AND no
// diff possible -- and the attempt is marked failed with a named reason
// (`arga_side_effect_evidence_unavailable`) instead of grading as a silent pass. See
// `deriveDiffOps`/`captureBaseline`/`evidenceGaps` below and docs/ARGA.md.
//
// No `ARGA_API_KEY` exists on this machine, so this file is built and tested only against local
// fakes (test/arga-backend.test.ts spins up a fake control plane + fake twin admin endpoints over
// node:http). It has never run against the real Arga service. Confirm the checklist in
// docs/ARGA.md's "45-minute confirmation checklist" before trusting a graded run.

export interface ArgaBackendOptions {
  apiKey: string;
  seed: TwinSeed;
  profile: FounderProfile;
  scenarioId: string;
  attempt: number;
  gate?: 'mcp' | 'library' | 'unavailable';
  extensions?: AgentDeps['features'];
  ruleOptions?: RuleOptions;
  release?: string;
  ledgerPath?: string;
  traceDir?: string | null;
  model?: EvidenceModel;
  baseUrl?: string;
  twins?: string[];
  ttlMinutes?: number;
  /** Injected for tests only: bypasses the real `fetch` global used by admin calls. */
  fetchImpl?: typeof fetch;
}

/** Confirmed twin identifiers (underscored) minus `linkedin`, which Arga does not offer as a twin
 * (see file header). Callers needing LinkedIn must read seeded fixtures instead. */
export const ARGA_TWIN_NAMES: string[] = ['gmail', 'google_calendar', 'google_drive', 'google_docs', 'google_sheets', 'github'];

/** The state shape src/twins/memory.ts's `MemoryTwins.state()` returns and harness/grade.ts and
 * harness/scenarios.ts read. The Arga adapter below maps each twin's admin state into this same
 * shape so grading code is backend-agnostic. */
export interface TwinsState {
  gmail: { messages: GmailMessage[] };
  calendar: { events: CalendarEvent[] };
  drive: { files: (DriveFile & { permissions: DrivePermission[]; content: Uint8Array })[] };
  docs: { documentId: string; title: string; text: string }[];
  sheets: { spreadsheetId: string; title: string; rows: string[][]; edits: { actor: 'agent' | 'admin'; row: number; col: number; value: string }[] }[];
  linkedin: { posts: unknown[]; followers: number } | null;
  ops: TwinOp[];
  stubHits: string[];
}

const STATE_TWINS = ['gmail', 'google_calendar', 'google_drive', 'google_docs', 'google_sheets', 'linkedin'] as const;

function sha256Hex(bytes: Uint8Array): string {
  // Local, dependency-free digest good enough to detect *any* content change across a diff; not a
  // cryptographic guarantee, just a stable fingerprint for baseline-vs-current comparison.
  let h = 0xcbf29ce4;
  for (const b of bytes) {
    h ^= b;
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/** Reads and mutates hosted twin admin state through `harness/arga.ts`'s helpers, caching the last
 * fetch so `.ops` / `.state()` / `.stubHits` are synchronous (grade.ts and scenarios.ts read them
 * without awaiting, matching MemoryTwins). Call `refresh()` after every agent run before grading.
 *
 * No-vacuous-pass guard: `ops` is populated from a real op log when a twin's `/admin/state` actually
 * returns one (`raw.ops`), and otherwise from a diff against `captureBaseline()`'s snapshot. If
 * NEITHER source is available for a twin that matters to grading (fetch failed for both baseline and
 * current state), that twin's name lands in `evidenceGaps` and `evidenceUnavailable` is true --
 * callers (see `run()` below) must fail the attempt rather than grade it, since an empty `ops` array
 * in that case does not mean "nothing happened," it means "we don't know." */
export class ArgaTwinsAdapter {
  readonly backend = 'arga' as const;
  private cached: TwinsState = { gmail: { messages: [] }, calendar: { events: [] }, drive: { files: [] }, docs: [], sheets: [], linkedin: null, ops: [], stubHits: [] };
  private baseline: TwinsState | null = null;
  private seq = 0;
  /** Twins that hit a second 410 during this attempt (harness admin calls, not the agent's own). */
  readonly degraded = new Set<string>();
  /** Twins for which this refresh could derive neither a real op log nor a state diff. */
  evidenceGaps: string[] = [];

  constructor(
    private readonly twins: Record<string, TwinInstance>,
    private readonly proxyToken: string,
    private readonly apiKey: string,
    private readonly runId: string,
    private readonly baseUrl: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private findTwin(...names: string[]): TwinInstance | undefined {
    for (const n of names) if (this.twins[n]) return this.twins[n];
    return undefined;
  }

  /** 410 handling per PRD 7.1/reliability-brief-template.md 5: extend once and retry; a second 410
   * marks the twin degraded for this attempt and returns `fallback` instead of throwing, so a
   * harness-side admin call never crashes the grader. */
  private async withExpiryRetry<T>(twinName: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof TwinExpiredError)) throw err;
      await argaExtend(this.apiKey, this.runId, { baseUrl: this.baseUrl }).catch(() => undefined);
      try {
        return await fn();
      } catch (err2) {
        if (!(err2 instanceof TwinExpiredError)) throw err2;
        this.degraded.add(twinName);
        return fallback;
      }
    }
  }

  private async adminAction(twin: TwinInstance | undefined, path: string, body: unknown): Promise<unknown> {
    if (!twin) return undefined;
    const res = await this.fetchImpl(`${twin.adminUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.proxyToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 410) throw new TwinExpiredError(twin.name);
    if (!res.ok) throw new Error(`${path} returned ${res.status} for twin '${twin.name}'`);
    return res.json();
  }

  /** Fetches `GET /admin/state?full=1` and `GET /admin/stub-hits` from every twin the grader reads
   * and merges them into a MemoryTwins-shaped snapshot. `sawState[twin]` tracks whether a usable
   * response came back at all, independent of whether it happened to contain any rows -- an empty
   * inbox is real evidence, a fetch failure is not. */
  private async fetchSnapshot(): Promise<{ snapshot: TwinsState; sawState: Record<string, boolean>; rawOpsSeen: Record<string, boolean> }> {
    const ops: TwinOp[] = [];
    const stubHits: string[] = [];
    const sawState: Record<string, boolean> = {};
    const rawOpsSeen: Record<string, boolean> = {};
    let gmail: GmailMessage[] = [];
    let calendar: CalendarEvent[] = [];
    let drive: TwinsState['drive']['files'] = [];
    let docs: TwinsState['docs'] = [];
    let sheets: TwinsState['sheets'] = [];
    let linkedin: TwinsState['linkedin'] = null;

    for (const canonical of STATE_TWINS) {
      const twin = this.twins[canonical];
      if (!twin) continue;

      // Any admin/state failure -- a 410 (handled by withExpiryRetry), a 500, a network error, a
      // non-JSON body -- means "no evidence for this twin," never a thrown exception that would
      // crash the whole env/attempt. captureBaseline/refresh turn a missing `sawState` entry into an
      // evidenceGaps entry instead (no-vacuous-pass guard).
      const state = await this.withExpiryRetry(canonical, () => fetchAdminState(twin, this.proxyToken), null).catch(() => null);
      if (state && typeof state === 'object') {
        sawState[canonical] = true;
        const raw = state as Record<string, unknown>;
        const data = (raw.data ?? raw) as Record<string, unknown>;
        if (canonical === 'gmail' && Array.isArray(data.messages)) gmail = data.messages as GmailMessage[];
        if (canonical === 'google_calendar' && Array.isArray(data.events)) calendar = data.events as CalendarEvent[];
        if (canonical === 'google_drive' && Array.isArray(data.files)) {
          drive = (data.files as Record<string, unknown>[]).map((f) => ({
            ...(f as unknown as DriveFile),
            permissions: (f.permissions as DrivePermission[]) ?? [],
            content: typeof f.content === 'string' ? Buffer.from(f.content as string, 'base64') : new Uint8Array(),
          }));
        }
        if (canonical === 'google_docs' && Array.isArray(data.documents)) docs = data.documents as TwinsState['docs'];
        if (canonical === 'google_sheets' && Array.isArray(data.spreadsheets)) sheets = data.spreadsheets as TwinsState['sheets'];
        if (canonical === 'linkedin') linkedin = { posts: (data.posts as unknown[]) ?? [], followers: Number(data.followers ?? 0) };

        // Real op log, when a twin actually has one (UNCONFIRMED for any Google/Gmail twin as of
        // 2026-09-13 -- see file header). Used verbatim when present; diffed against otherwise.
        const rawOps = Array.isArray(raw.ops) ? (raw.ops as Record<string, unknown>[]) : [];
        if (rawOps.length > 0) {
          rawOpsSeen[canonical] = true;
          for (const o of rawOps) {
            this.seq += 1;
            ops.push({ seq: this.seq, app: canonical === 'google_calendar' ? 'calendar' : canonical.replace('google_', ''), op: String(o.op ?? ''), actor: (o.actor as TwinOp['actor']) ?? 'agent', detail: (o.detail as Record<string, unknown>) ?? {} });
          }
        }
      }

      const hits = await this.withExpiryRetry(canonical, () => fetchStubHits(twin, this.proxyToken), null).catch(() => null);
      if (Array.isArray(hits)) stubHits.push(...(hits as unknown[]).map(String));
      else if (hits && typeof hits === 'object' && Array.isArray((hits as Record<string, unknown>).hits)) stubHits.push(...((hits as Record<string, unknown>).hits as unknown[]).map(String));
    }

    ops.sort((a, b) => a.seq - b.seq);
    return { snapshot: { gmail: { messages: gmail }, calendar: { events: calendar }, drive: { files: drive }, docs, sheets, linkedin, ops, stubHits }, sawState, rawOpsSeen };
  }

  /** Call once, right after provisioning/reseeding and before the agent's first run, so later
   * refreshes have something to diff against. */
  async captureBaseline(): Promise<void> {
    const { snapshot, sawState } = await this.fetchSnapshot();
    this.baseline = snapshot;
    this.cached = snapshot;
    this.evidenceGaps = STATE_TWINS.filter((t) => this.twins[t] && !sawState[t]);
  }

  /** Derives write-shaped `TwinOp`s from baseline-vs-current differences, for twins whose
   * `/admin/state` carried no op log. Best-effort and conservative: it only flags things the grader
   * actually reads (`prohibitedSideEffects` in harness/grade.ts), attributed `actor: 'agent'` since
   * nothing else could have produced them between two harness-controlled snapshots taken back to
   * back around a single agent run. */
  private deriveDiffOps(baseline: TwinsState, current: TwinsState): TwinOp[] {
    const out: TwinOp[] = [];
    const push = (app: string, op: string, detail: Record<string, unknown>) => {
      this.seq += 1;
      out.push({ seq: this.seq, app, op, actor: 'agent', detail });
    };

    const baseGmailIds = new Set(baseline.gmail.messages.map((m) => m.id));
    for (const m of current.gmail.messages) {
      if (baseGmailIds.has(m.id)) continue;
      // Any message that appeared since the baseline is flagged as a `messages.send`, deliberately
      // over-inclusive: without a real op log we cannot distinguish the agent sending mail from an
      // admin/world-side insert (scenarios.ts's adminAddMessage also lands here), but per the
      // no-vacuous-pass rule a false positive the grader can dismiss beats a missed real send. If
      // this proves too noisy in practice, the fix is to have Arga document a real op log, not to
      // narrow this heuristic.
      push('gmail', 'messages.send', { id: m.id, to: m.to, from: m.from });
    }

    const baseDriveById = new Map(baseline.drive.files.map((f) => [f.id, f]));
    for (const f of current.drive.files) {
      const before = baseDriveById.get(f.id);
      if (!before) {
        push('drive', 'files.create', { fileId: f.id, path: f.name, sha256: sha256Hex(f.content) });
        continue;
      }
      if (sha256Hex(f.content) !== sha256Hex(before.content)) {
        push('drive', 'files.update', { fileId: f.id, path: f.name });
      }
      const beforePerms = new Set(before.permissions.map((p) => `${p.role}:${p.emailAddress ?? p.type}`));
      for (const p of f.permissions) {
        const key = `${p.role}:${p.emailAddress ?? p.type}`;
        if (!beforePerms.has(key)) push('drive', 'permissions.create', { fileId: f.id, role: p.role, emailAddress: p.emailAddress });
      }
    }

    const baseCalIds = new Set(baseline.calendar.events.map((e) => e.id));
    for (const e of current.calendar.events) if (!baseCalIds.has(e.id)) push('calendar', 'events.insert', { id: e.id });

    if (baseline.linkedin && current.linkedin && current.linkedin.posts.length > baseline.linkedin.posts.length) {
      push('linkedin', 'posts.create', { countBefore: baseline.linkedin.posts.length, countAfter: current.linkedin.posts.length });
    }

    return out;
  }

  /** Fetches current state and merges in diff-derived ops for any twin whose state didn't carry a
   * real op log. Populates `evidenceGaps`/`evidenceUnavailable` when a twin has neither a real op
   * log NOR a usable baseline+current pair to diff. Call after every `env.run()`. */
  async refresh(): Promise<void> {
    const { snapshot, sawState, rawOpsSeen } = await this.fetchSnapshot();
    const gaps: string[] = [];

    if (this.baseline) {
      for (const t of STATE_TWINS) {
        if (!this.twins[t]) continue;
        if (rawOpsSeen[t]) continue; // real op log covers this twin; no diff needed.
        if (!sawState[t]) {
          gaps.push(t); // never got state at all -- no diff possible either.
        }
      }
      const diffOps = this.deriveDiffOps(this.baseline, snapshot);
      snapshot.ops = [...snapshot.ops, ...diffOps].sort((a, b) => a.seq - b.seq);
    } else {
      // No baseline was ever captured (captureBaseline() wasn't called, or it also failed) -- there
      // is no diff source, so every twin that also lacks a real op log is an evidence gap.
      for (const t of STATE_TWINS) if (this.twins[t] && !rawOpsSeen[t]) gaps.push(t);
    }

    this.cached = snapshot;
    this.evidenceGaps = gaps;
  }

  /** True when at least one provisioned, state-bearing twin has no evidence source at all this
   * refresh (neither a real op log nor a baseline to diff against). `run()` below fails the attempt
   * on this rather than grading it, per the no-vacuous-pass rule. */
  get evidenceUnavailable(): boolean {
    return this.evidenceGaps.length > 0;
  }

  /** Structural parity with MemoryTwins.recordOp / harness/env.ts's `TwinsHandle` (harness/presets.ts
   * and several scenarios call this unconditionally on `env.twins`). A hosted twin's own admin
   * writes already show up via `refresh()`'s diff/op-log read, so this just appends locally for
   * harness code that wants to record a synthetic op inline (e.g. admin-side test/setup helpers)
   * without waiting for the next refresh. */
  recordOp(app: string, op: string, actor: TwinOp['actor'], detail: Record<string, unknown>): void {
    this.seq += 1;
    this.cached.ops = [...this.cached.ops, { seq: this.seq, app, op, actor, detail }];
  }

  get ops(): TwinOp[] {
    return this.cached.ops;
  }

  get stubHits(): string[] {
    return this.cached.stubHits;
  }

  state(): TwinsState {
    return this.cached;
  }

  drivePath(fileId: string): string {
    const byId = new Map(this.cached.drive.files.map((f) => [f.id, f]));
    const parts: string[] = [];
    let cur = byId.get(fileId);
    while (cur) {
      parts.unshift(cur.name);
      const parent = cur.parents[0];
      cur = parent && parent !== 'root' ? byId.get(parent) : undefined;
    }
    return parts.join('/');
  }

  driveContent(fileId: string): Uint8Array | null {
    return this.cached.drive.files.find((f) => f.id === fileId)?.content ?? null;
  }

  /** Admin surface used by scenarios.ts (S11, S18, S14) to act as the founder or the world. Paths
   * below are UNCONFIRMED guesses at REST conventions; only `/admin/state` and `/admin/stub-hits`
   * are documented (PRD 7.1, docs.argalabs.com/features/twins-quickstart). */
  async adminAddMessage(msg: Omit<GmailMessage, 'id' | 'raw' | 'labels' | 'headers' | 'threadId'> & Partial<Pick<GmailMessage, 'threadId' | 'headers' | 'labels'>>): Promise<void> {
    const twin = this.findTwin('gmail');
    await this.withExpiryRetry('gmail', () => this.adminAction(twin, '/admin/messages', msg), undefined);
  }

  async adminShareFile(fileId: string, email: string): Promise<void> {
    const twin = this.findTwin('google_drive');
    await this.withExpiryRetry('google_drive', () => this.adminAction(twin, '/admin/permissions', { fileId, email, role: 'reader' }), undefined);
  }

  async adminOverwriteFile(fileId: string, content: Uint8Array | string): Promise<void> {
    const twin = this.findTwin('google_drive');
    const body = typeof content === 'string' ? content : Buffer.from(content).toString('base64');
    await this.withExpiryRetry('google_drive', () => this.adminAction(twin, `/admin/files/${encodeURIComponent(fileId)}/overwrite`, { content: body }), undefined);
  }

  async adminSetSheetCell(spreadsheetId: string, match: { column: string; equals: string }, column: string, value: string): Promise<void> {
    const twin = this.findTwin('google_sheets');
    await this.withExpiryRetry('google_sheets', () => this.adminAction(twin, `/admin/sheets/${encodeURIComponent(spreadsheetId)}/cells`, { match, column, value }), undefined);
  }
}

export interface ArgaHarnessEnv {
  twins: ArgaTwinsAdapter;
  ledger: Ledger;
  tracer: LocalTracer;
  gate: WorthSendingGate;
  deps: AgentDeps;
  profile: FounderProfile;
  clock: { now(): Date; set(d: Date): void; advance(ms: number): void };
  runs: RunSummary[];
  runId: string;
  /** The Arga *scenario* id (client.scenarios.create's return), not a disposable twins.provision
   * run id. Cache this across attempts for the same Exhibit scenario and pass it back in as
   * `reuseArgaScenarioId` so the seed is created once and reused (PRD 7.1's "one Twin Run ID",
   * updated for the scenario-based seeding path -- see file header). */
  argaScenarioId: string;
  run(): Promise<RunSummary>;
  close(): Promise<void>;
}

/** Applies both post-run degradation guards to a `RunSummary` in place, given the adapter that just
 * finished `refresh()`ing. Split out from `run()` so it can be exercised directly in tests without
 * running the full Exhibit agent pipeline against fake twin API surfaces (see
 * test/arga-backend.test.ts's "no-vacuous-pass guard" tests). */
export function applyDegradationGuards(summary: RunSummary, adapter: ArgaTwinsAdapter): void {
  // A harness-side admin call (refresh, adminAddMessage, ...) that hit a second 410 this attempt
  // degrades it too, even if the agent's own calls never expired.
  if (adapter.degraded.size > 0) {
    summary.outcome = 'degraded';
    for (const t of adapter.degraded) if (!summary.degraded.includes(t)) summary.degraded.push(t);
  }

  // No-vacuous-pass guard (risk #2): if grading has no evidence source for a provisioned twin (no
  // real op log AND no usable diff), never let the attempt read as clean. Fail it with a named,
  // greppable reason instead of silently returning an empty `ops` array.
  if (adapter.evidenceUnavailable) {
    summary.outcome = 'degraded';
    const reason = `arga_side_effect_evidence_unavailable: ${adapter.evidenceGaps.join(', ')}`;
    if (!summary.degraded.includes(reason)) summary.degraded.push(reason);
  }
}

function makeGate(kind: ArgaBackendOptions['gate']): WorthSendingGate {
  if (kind === 'library') return new LibraryWorthSendingGate();
  if (kind === 'unavailable') return new UnavailableGate();
  return new McpWorthSendingGate();
}

/** Provisions (or reuses) one Arga *scenario* for `scenarioId` and ensures its twin environment,
 * reseeding instead of recreating on attempt > 1 (PRD 12.3; see file header for why this replaced
 * the old `twins.provision`/`twins.reset` run-based flow). Builds an env structurally compatible
 * with harness/env.ts's HarnessEnv -- see the exact runner.ts patch documented in docs/ARGA.md for
 * wiring this in as `--backend arga`. */
export async function createArgaHarnessEnv(opts: ArgaBackendOptions & { reuseArgaScenarioId?: string }): Promise<ArgaHarnessEnv> {
  const client = new Arga({ apiKey: opts.apiKey, baseUrl: opts.baseUrl, fetch: opts.fetchImpl });
  const seedConfig = toArgaSeedConfig(opts.seed, opts.profile);
  const twinNames = opts.twins ?? ARGA_TWIN_NAMES;

  let argaScenarioId = opts.reuseArgaScenarioId;
  if (!argaScenarioId) {
    const scenario = await client.scenarios.create({ name: `exhibit-${opts.scenarioId}`, seedConfig, twins: twinNames as never });
    argaScenarioId = scenario.id;
  } else {
    await client.scenarios.reseedTwinEnvironment(argaScenarioId);
  }

  let twinEnv = await client.scenarios.ensureTwinEnvironment(argaScenarioId, { twins: twinNames as never });
  const deadline = Date.now() + 120_000;
  while (twinEnv.status !== 'ready') {
    if (twinEnv.status === 'error' || twinEnv.status === 'failed') throw new Error(`Arga scenario twin environment failed for scenario ${argaScenarioId}: ${twinEnv.error ?? twinEnv.status}`);
    if (Date.now() > deadline) throw new Error(`Arga scenario twin environment timed out for scenario ${argaScenarioId}`);
    await new Promise((r) => setTimeout(r, 1000));
    twinEnv = await client.scenarios.getTwinEnvironment(argaScenarioId);
  }

  // CONFIRMED 2026-09-13 (node_modules/arga-sdk/dist/index.js, HttpClient.handleResponse ->
  // toCamelCaseKeys): the SDK recursively camelCases every key of every JSON response, including
  // the `twins` record's own keys -- so a twin the server keys as `google_calendar` comes back from
  // `ensureTwinEnvironment`/`getTwinEnvironment` keyed as `googleCalendar`, not `google_calendar`.
  // `TwinInstance.name` is a string VALUE, not a key, so it survives untouched (`convertKeys` only
  // maps object keys). Re-key by `.name` so this file's own STATE_TWINS lookups (and harness/arga.ts's
  // `findTwin`, which tries hyphen/underscore key spellings but not camelCase) see the twin under its
  // documented name.
  const twins: Record<string, TwinInstance> = {};
  for (const t of Object.values(twinEnv.twins)) if (typeof t.name === 'string' && t.name) twins[t.name] = t;
  const proxyToken = twinEnv.proxyToken ?? '';
  const runId = twinEnv.runId ?? twinEnv.id;

  const adapter = new ArgaTwinsAdapter(twins, proxyToken, opts.apiKey, runId, opts.baseUrl, opts.fetchImpl);
  await adapter.captureBaseline();
  const apps = argaApps({ runId, status: 'ready', twins, proxyToken }, opts.profile.emails[0]!, opts.profile);

  const ledger = new Ledger(opts.ledgerPath ?? ':memory:');
  const tracer = new LocalTracer(opts.traceDir ?? null);
  const gate = makeGate(opts.gate);
  const g = graph();

  let now = new Date();
  const clock = {
    now: () => new Date(now.getTime()),
    set: (d: Date) => (now = new Date(d.getTime())),
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
  };

  const deps: AgentDeps = {
    apps,
    ledger,
    tracer,
    profile: opts.profile,
    model: opts.model ?? defaultModel(),
    graph: g,
    researcher: new FixtureResearcher(WEB_FIXTURES),
    fetcher: new FixtureFetcher(WEB_FIXTURES),
    policy: sourcePolicy(g, true),
    gate,
    clock,
    release: opts.release ?? 'dev',
    extend: () => argaExtend(opts.apiKey, runId, { baseUrl: opts.baseUrl }),
    mode: 'harness',
    scenarioId: opts.scenarioId ?? null,
    attempt: opts.attempt ?? null,
    ruleOptions: opts.ruleOptions,
    features: opts.extensions,
  };

  const runs: RunSummary[] = [];
  return {
    twins: adapter,
    ledger,
    tracer,
    gate,
    deps,
    profile: opts.profile,
    clock,
    runs,
    runId,
    argaScenarioId,
    async run() {
      const rid = `${opts.scenarioId}-a${opts.attempt}-r${runs.length + 1}`;
      const summary = await runExhibit(deps, { runId: rid });
      await adapter.refresh();
      applyDegradationGuards(summary, adapter);
      runs.push(summary);
      return summary;
    },
    async close() {
      await gate.close();
      ledger.close();
      await client.scenarios.deleteTwinEnvironment(argaScenarioId!).catch(() => undefined);
    },
  };
}
