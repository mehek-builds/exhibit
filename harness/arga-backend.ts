import { createHash } from 'node:crypto';
import { Arga } from 'arga-sdk';
import type { TwinInstance } from 'arga-sdk';
import type { AgentDeps, RunSummary } from '../src/agent.js';
import { runExhibit } from '../src/agent.js';
import type { Apps, CalendarEvent, DriveFile, DrivePermission, GmailMessage } from '../src/apps/types.js';
import { FOLDER_MIME, TwinExpiredError } from '../src/apps/types.js';
import { Ledger } from '../src/ledger.js';
import type { WorthSendingGate } from '../src/letters/worthSending.js';
import { LibraryWorthSendingGate, McpWorthSendingGate, UnavailableGate } from '../src/letters/worthSending.js';
import type { EvidenceModel } from '../src/models/types.js';
import { LocalTracer } from '../src/observability/tracer.js';
import { sourcePolicy } from '../src/research/corroborator.js';
import { FixtureFetcher, FixtureResearcher } from '../src/research/fixture.js';
import type { RuleOptions } from '../src/rules/explicit.js';
import type { TwinOp, TwinOptions, TwinSeed } from '../src/twins/memory.js';
import { buildEml, MemoryTwins } from '../src/twins/memory.js';
import type { FounderProfile } from '../src/types.js';
import { mapLimit } from '../src/util.js';
import { ARGA_API_BASE_URL, argaApps, extend as argaExtend, tokenFor } from './arga.js';
import { ARGA_GOOGLE_TWINS, calendarInsertBody, gmailInsertBody, seedMessagesInOrder, toArgaSeedConfig } from './arga-seed.js';
import { NOW } from './corpus.js';
import { WEB_FIXTURES } from './fixtures.js';
import { defaultModel, graph } from './env.js';

// Hosted-twin backend for the Arga matrix (PRD 7.1, 12.3, 12.6): the harness environment scenarios
// run against, on real Arga twins instead of src/twins/memory.ts. Everything below was verified
// against live Arga twins on 2026-09-13 (docs/ARGA.md has the probe results).
//
// ENVIRONMENT: one saved Arga scenario (`exhibit-twins`) holds the twin skeleton; its long-lived
// twin environment is ensured per attempt and torn down on close(). Five Google twins in one
// environment work on the Free plan (the one-twin limit applies to short-lived Twin Runs).
//
// SEEDING: Dara Voss's messages and events go in through the twins' own Gmail and Calendar APIs
// after the environment is ready (see harness/arga-seed.ts for why not `seed_config`). GitHub and
// LinkedIn are read from the scenario's seeded fixture through MemoryTwins (PRD 7.1 fallback).
//
// GRADING: state is read through the twins' public Google APIs with each twin's own token, using
// the same src/apps/live clients the agent uses, plus a Drive files.list for enumeration. Arga's
// `/admin/state` layouts differ per twin and carry no op log and no Drive file content, so they are
// not used. Side effects are derived from a diff against a baseline read taken after seeding. World
// actions a scenario performs mid-attempt (a new email, a share, an overwrite, a sheet edit) go
// through the same APIs and are excluded from the diff by id, so they are never counted as agent
// writes.
//
// NO-VACUOUS-PASS GUARD: a twin whose state cannot be read lands in `evidenceGaps`, and the attempt
// is forced to `degraded` with `arga_side_effect_evidence_unavailable: <twins>`, never a clean pass.

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
  /** Injected for tests only: replaces the `fetch` used for Arga control-plane and twin calls. */
  fetchImpl?: typeof fetch;
  /** Milliseconds to wait for a twin environment to report ready. */
  readyTimeoutMs?: number;
  /** Saved Arga scenario to build the environment from (default `exhibit-twins`). */
  scenarioName?: string;
  /** Leave the twin environment up on close() so it can be browsed in Arga (the demo). */
  keepEnvironment?: boolean;
  /** The agent's clock start; defaults to the corpus's synthetic NOW, as in memory mode. */
  now?: Date;
  /** Options for the fixture-backed apps (GitHub, LinkedIn), e.g. `linkedinUnavailable`. */
  twinOptions?: Partial<Omit<TwinOptions, 'now'>>;
}

/** The twins provisioned on Arga. GitHub and LinkedIn come from seeded fixtures (file header). */
export const ARGA_TWIN_NAMES: string[] = [...ARGA_GOOGLE_TWINS];

/** Name of the one saved Arga scenario every attempt's environment is built from. */
export const ARGA_SCENARIO_NAME = 'exhibit-twins';

/** The state shape src/twins/memory.ts's `MemoryTwins.state()` returns and harness/grade.ts and
 * harness/scenarios.ts read, so grading code is backend-agnostic. */
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

const DOC_MIME = 'application/vnd.google-apps.document';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';

const hashOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function isExpired(err: unknown): boolean {
  if (err instanceof TwinExpiredError) return true;
  const e = err as { status?: number; code?: number | string; response?: { status?: number } };
  return e?.status === 410 || e?.code === 410 || e?.response?.status === 410;
}

/** Raw calls to a twin's public API with that twin's own token, for the operations the shared
 * src/apps/live clients do not expose (insert, share, list everything, set one cell). */
export class ArgaTwinApi {
  constructor(
    private readonly twins: Record<string, TwinInstance>,
    private readonly proxyToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  has(name: string): boolean {
    return !!this.twins[name];
  }

  async call<T = Record<string, unknown>>(name: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const twin = this.twins[name];
    if (!twin) throw new Error(`twin '${name}' is not provisioned`);
    const res = await this.fetchImpl(`${twin.baseUrl.replace(/\/$/, '')}${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${tokenFor({ proxyToken: this.proxyToken }, twin)}`, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    if (res.status === 410) throw new TwinExpiredError(name);
    const text = await res.text();
    if (!res.ok) throw new Error(`${name} ${init.method ?? 'GET'} ${path} returned ${res.status}: ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async insertMessage(m: GmailMessage, threadId?: string): Promise<{ id: string; threadId: string }> {
    return this.call('gmail', '/gmail/v1/users/me/messages', { method: 'POST', body: gmailInsertBody(m, threadId) });
  }

  async insertEvent(e: CalendarEvent): Promise<{ id: string }> {
    return this.call('google_calendar', '/calendar/v3/calendars/primary/events', { method: 'POST', body: calendarInsertBody(e) });
  }

  async countMessages(): Promise<number> {
    const res = await this.call<{ messages?: unknown[] }>('gmail', '/gmail/v1/users/me/messages?maxResults=10');
    return res.messages?.length ?? 0;
  }

  /** Every non-trashed file in the shared Workspace twin (Drive, Docs and Sheets share one store). */
  async listAllFiles(): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({ q: 'trashed = false', pageSize: '1000', fields: 'nextPageToken,files(id,name,mimeType,parents,size,sha256Checksum,createdTime,modifiedTime,appProperties)' });
      if (pageToken) q.set('pageToken', pageToken);
      const res = await this.call<{ files?: Record<string, unknown>[]; nextPageToken?: string | null }>('google_drive', `/drive/v3/files?${q}`);
      for (const f of res.files ?? []) {
        out.push({
          id: String(f.id ?? ''),
          name: String(f.name ?? ''),
          mimeType: String(f.mimeType ?? ''),
          parents: (f.parents as string[]) ?? [],
          size: Number(f.size ?? 0),
          sha256: (f.sha256Checksum as string) ?? null,
          createdTime: String(f.createdTime ?? ''),
          modifiedTime: String(f.modifiedTime ?? ''),
          appProperties: (f.appProperties as Record<string, string>) ?? {},
        });
      }
      pageToken = res.nextPageToken ?? undefined;
    } while (pageToken);
    return out;
  }

  async addPermission(fileId: string, emailAddress: string): Promise<void> {
    await this.call('google_drive', `/drive/v3/files/${encodeURIComponent(fileId)}/permissions`, { method: 'POST', body: { role: 'reader', type: 'user', emailAddress } });
  }

  async setCell(spreadsheetId: string, a1: string, value: string): Promise<void> {
    await this.call('google_sheets', `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(a1)}?valueInputOption=RAW`, { method: 'PUT', body: { range: a1, values: [[value]] } });
  }
}

function pathIn(state: TwinsState, fileId: string): string {
  const byId = new Map(state.drive.files.map((f) => [f.id, f]));
  const parts: string[] = [];
  let cur = byId.get(fileId);
  while (cur) {
    parts.unshift(cur.name);
    const parent = cur.parents[0];
    cur = parent && parent !== 'root' ? byId.get(parent) : undefined;
  }
  return parts.join('/');
}

function columnLetter(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Twin-assigned ids <-> the scenario's seed ids. The twins assign their own message, thread and
 * event ids on insert; graders look candidates up by the seed's (`gmail:m-accel`), so the agent and
 * the grader see seed ids for seeded items and twin ids for anything created during the attempt. */
export class SeedIdMap {
  private readonly toSeed = { message: new Map<string, string>(), thread: new Map<string, string>(), event: new Map<string, string>() };
  private readonly toTwin = { message: new Map<string, string>(), thread: new Map<string, string>(), event: new Map<string, string>() };

  set(kind: 'message' | 'thread' | 'event', seedId: string, twinId: string): void {
    this.toSeed[kind].set(twinId, seedId);
    this.toTwin[kind].set(seedId, twinId);
  }

  seedOf(kind: 'message' | 'thread' | 'event', twinId: string): string {
    return this.toSeed[kind].get(twinId) ?? twinId;
  }

  twinOf(kind: 'message' | 'thread' | 'event', id: string): string | undefined {
    return this.toTwin[kind].get(id) ?? (this.toSeed[kind].has(id) ? id : undefined);
  }

  message(m: GmailMessage): GmailMessage {
    return { ...m, id: this.seedOf('message', m.id), threadId: this.seedOf('thread', m.threadId) };
  }

  event(e: CalendarEvent): CalendarEvent {
    return { ...e, id: this.seedOf('event', e.id) };
  }
}

/** Inserts the scenario's messages (oldest first, threads kept together) and calendar events. */
export async function seedTwinsThroughApis(api: ArgaTwinApi, seed: TwinSeed): Promise<SeedIdMap> {
  const ids = new SeedIdMap();
  // Threads are independent, so they go in 8 at a time; within a thread, oldest first so replies
  // land in the thread the first message opened.
  const threads = new Map<string, GmailMessage[]>();
  for (const m of seedMessagesInOrder(seed)) threads.set(m.threadId, [...(threads.get(m.threadId) ?? []), m]);
  await mapLimit([...threads.values()], 8, async (msgs) => {
    for (const m of msgs) {
      const res = await api.insertMessage(m, ids.twinOf('thread', m.threadId));
      ids.set('message', m.id, res.id);
      if (!ids.twinOf('thread', m.threadId)) ids.set('thread', m.threadId, res.threadId);
    }
  });
  await mapLimit(seed.calendar, 8, async (e) => ids.set('event', e.id, (await api.insertEvent(e)).id));
  return ids;
}

/** Arga's Drive twin injects its own control-panel markup (a `<style>`, `<aside>` and `<script>`,
 * each tagged `data-twin-control-plane`) just before `</body>` when it serves a `text/html` file
 * (verified 2026-09-13: 90 bytes stored, 6,776 served). The real Drive never does this, and it breaks
 * every snapshot hash check, so the harness removes exactly that block on read. Files without the
 * marker are returned untouched. */
const TWIN_UI_MARKER = 'data-twin-control-plane';
export function stripTwinControlPlane(bytes: Uint8Array): Uint8Array {
  const text = Buffer.from(bytes).toString('utf8');
  if (!text.includes(TWIN_UI_MARKER)) return bytes;
  const start = text.indexOf(`\n<style ${TWIN_UI_MARKER}>`);
  const end = text.lastIndexOf('</script>\n');
  if (start < 0 || end < start) return bytes;
  return Buffer.from(text.slice(0, start) + text.slice(end + '</script>\n'.length), 'utf8');
}

/** The agent's Gmail and Calendar clients, translated to seed ids (see SeedIdMap). */
function withSeedIds(apps: Apps, ids: SeedIdMap): Apps {
  return {
    ...apps,
    gmail: {
      listMessages: async () => (await apps.gmail.listMessages()).map((m) => ids.message(m)),
      send: async (email) => {
        const res = await apps.gmail.send({ ...email, threadId: email.threadId ? ids.twinOf('thread', email.threadId) ?? email.threadId : undefined });
        return { id: ids.seedOf('message', res.id), threadId: ids.seedOf('thread', res.threadId) };
      },
    },
    calendar: {
      listEvents: async () => (await apps.calendar.listEvents()).map((e) => ids.event(e)),
    },
    drive: {
      ...apps.drive,
      readFile: async (fileId) => stripTwinControlPlane(await apps.drive.readFile(fileId)),
    },
  };
}

/** What the agent's own clients did that the twins' state cannot show on its own: the bytes each
 * created file had at upload (a file created and edited in the same run otherwise first appears
 * already edited), and Docs/Sheets writes (native files are not content-diffed). */
export interface AgentCallLog {
  uploads: Map<string, string>;
  ops: { app: string; op: string; detail: Record<string, unknown> }[];
}

/** The agent's clients: `apps` plus the AgentCallLog records. The adapter reads (and performs world
 * actions) through the unlogged `apps`, so nothing it does is attributed to the agent. */
function withAgentLog(apps: Apps, log: AgentCallLog): Apps {
  return {
    ...apps,
    drive: {
      ...apps.drive,
      createFile: async (params) => {
        const f = await apps.drive.createFile(params);
        log.uploads.set(f.id, hashOf(typeof params.content === 'string' ? Buffer.from(params.content, 'utf8') : params.content));
        return f;
      },
    },
    docs: {
      ...apps.docs,
      create: async (title) => {
        const res = await apps.docs.create(title);
        log.ops.push({ app: 'docs', op: 'documents.create', detail: { documentId: res.documentId, title } });
        return res;
      },
      replaceText: async (documentId, text) => {
        await apps.docs.replaceText(documentId, text);
        log.ops.push({ app: 'docs', op: 'documents.batchUpdate', detail: { documentId, length: text.length } });
      },
    },
    sheets: {
      ...apps.sheets,
      create: async (title, headers) => {
        const res = await apps.sheets.create(title, headers);
        log.ops.push({ app: 'sheets', op: 'spreadsheets.create', detail: { spreadsheetId: res.spreadsheetId, title } });
        return res;
      },
      appendRows: async (spreadsheetId, rows) => {
        await apps.sheets.appendRows(spreadsheetId, rows);
        log.ops.push({ app: 'sheets', op: 'values.append', detail: { spreadsheetId, rows: rows.length } });
      },
    },
  };
}

/** Reads and mutates hosted twin state, caching the last read so `.ops` / `.state()` are
 * synchronous (grade.ts and scenarios.ts read them without awaiting, like MemoryTwins). Call
 * `refresh()` after every agent run before grading. */
export class ArgaTwinsAdapter {
  readonly backend = 'arga' as const;
  private cached: TwinsState = { gmail: { messages: [] }, calendar: { events: [] }, drive: { files: [] }, docs: [], sheets: [], linkedin: null, ops: [], stubHits: [] };
  private baseline: TwinsState | null = null;
  private seq = 0;
  /** Append-only op log (s25 slices it by position): fixture ops, world actions, diff-derived
   * agent writes, each appended once in the order it was observed. */
  private log: TwinOp[] = [];
  private readonly emitted = new Set<string>();
  private fixtureOpsSeen = 0;
  private agentLogSeen = 0;
  private readonly adminMessageIds = new Set<string>();
  private readonly adminPermissions = new Set<string>();
  private readonly adminContent = new Map<string, string>();
  /** World actions run one at a time, in call order: scenarios fire them without awaiting (they
   * are synchronous in memory), and order matters (Deny before its Reason, approvals by date). */
  private queue: Promise<void> = Promise.resolve();
  private queueError: unknown = null;
  /** Content hash of each agent-created file when it was first seen. */
  private readonly firstSeen = new Map<string, string>();
  private readonly sheetEdits = new Map<string, TwinsState['sheets'][number]['edits']>();
  /** Twins that hit a second 410 during this attempt. */
  readonly degraded = new Set<string>();
  /** Twins whose state could not be read on the last refresh. */
  evidenceGaps: string[] = [];

  constructor(
    private readonly api: ArgaTwinApi,
    private readonly apps: Apps,
    private readonly fixtures: MemoryTwins,
    private readonly ids: SeedIdMap,
    private readonly agentLog: AgentCallLog,
    private readonly apiKey: string,
    private readonly runId: string,
    private readonly baseUrl: string | undefined,
  ) {}

  /** 410 handling per PRD 7.1: extend once and retry; a second 410 marks the twin degraded and
   * returns `fallback` instead of throwing, so a harness-side call never crashes the grader. */
  private async withExpiryRetry<T>(twinName: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (!isExpired(err)) throw err;
      await argaExtend(this.apiKey, this.runId, { baseUrl: this.baseUrl }).catch(() => undefined);
      try {
        return await fn();
      } catch (err2) {
        if (!isExpired(err2)) throw err2;
        this.degraded.add(twinName);
        return fallback;
      }
    }
  }

  /** Reads one twin; a failure means "no evidence for this twin", never a thrown exception. */
  private async read<T>(twin: string, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
    try {
      const value = await this.withExpiryRetry(twin, fn, undefined as T | undefined);
      return value === undefined ? { ok: false } : { ok: true, value };
    } catch {
      return { ok: false };
    }
  }

  private async fetchSnapshot(): Promise<{ snapshot: TwinsState; failed: string[] }> {
    const failed: string[] = [];
    const gmail = await this.read('gmail', () => this.apps.gmail.listMessages());
    if (!gmail.ok) failed.push('gmail');
    const calendar = await this.read('google_calendar', () => this.apps.calendar.listEvents());
    if (!calendar.ok) failed.push('google_calendar');

    let drive: TwinsState['drive']['files'] = [];
    let docs: TwinsState['docs'] = [];
    let sheets: TwinsState['sheets'] = [];
    const all = await this.read('google_drive', () => this.api.listAllFiles());
    if (!all.ok) {
      failed.push('google_drive', 'google_docs', 'google_sheets');
    } else {
      const driveRead = await this.read('google_drive', async () => {
        return mapLimit(all.value.filter((x) => x.mimeType !== DOC_MIME && x.mimeType !== SHEET_MIME), 8, async (f) => {
          const [permissions, content] = await Promise.all([this.apps.drive.listPermissions(f.id), f.mimeType === FOLDER_MIME ? Promise.resolve(new Uint8Array()) : this.apps.drive.readFile(f.id)]);
          return { ...f, permissions, content };
        });
      });
      if (driveRead.ok) drive = driveRead.value;
      else failed.push('google_drive');

      const docsRead = await this.read('google_docs', async () => {
        return mapLimit(all.value.filter((x) => x.mimeType === DOC_MIME), 8, async (f) => ({ documentId: f.id, title: f.name, text: await this.apps.docs.getText(f.id) }));
      });
      if (docsRead.ok) docs = docsRead.value;
      else failed.push('google_docs');

      const sheetsRead = await this.read('google_sheets', async () => {
        return mapLimit(all.value.filter((x) => x.mimeType === SHEET_MIME), 8, async (f) => ({ spreadsheetId: f.id, title: f.name, rows: await this.apps.sheets.readRows(f.id), edits: this.sheetEdits.get(f.id) ?? [] }));
      });
      if (sheetsRead.ok) sheets = sheetsRead.value;
      else failed.push('google_sheets');
    }

    const fixtureState = this.fixtures.state();
    const snapshot: TwinsState = {
      gmail: { messages: gmail.ok ? gmail.value : [] },
      calendar: { events: calendar.ok ? calendar.value : [] },
      drive: { files: drive },
      docs,
      sheets,
      linkedin: fixtureState.linkedin,
      ops: [],
      // Arga exposes no stub-hit endpoint for the Google twins (GET /admin/stub-hits is 404 on
      // gmail and google_drive); the fixture-backed apps still report theirs.
      stubHits: fixtureState.stubHits,
    };
    return { snapshot, failed: failed.filter((t) => this.api.has(t)) };
  }

  /** Call once, after seeding and before the agent's first run. */
  async captureBaseline(): Promise<void> {
    const { snapshot, failed } = await this.fetchSnapshot();
    // Without a complete baseline every seeded item would later diff as an agent write.
    if (failed.length > 0) throw new Error(`arga_baseline_unreadable: ${failed.join(', ')}`);
    this.baseline = snapshot;
    this.cached = snapshot;
    this.evidenceGaps = failed;
  }

  /** Write-shaped ops from baseline-vs-current differences, attributed to the agent unless a world
   * action this adapter performed produced them. */
  private deriveDiffOps(baseline: TwinsState, current: TwinsState): { key: string; app: string; op: string; detail: Record<string, unknown> }[] {
    const out: { key: string; app: string; op: string; detail: Record<string, unknown> }[] = [];
    const push = (app: string, op: string, detail: Record<string, unknown>, key: string) => out.push({ key: `${app}|${op}|${key}`, app, op, detail });

    const baseGmailIds = new Set(baseline.gmail.messages.map((m) => m.id));
    for (const m of current.gmail.messages) {
      if (baseGmailIds.has(m.id) || this.adminMessageIds.has(m.id)) continue;
      push('gmail', 'messages.send', { id: m.id, to: m.to, from: m.from, subject: m.subject, body: m.body }, m.id);
    }

    const baseDriveById = new Map(baseline.drive.files.map((f) => [f.id, f]));
    for (const f of current.drive.files) {
      const now = hashOf(f.content);
      const before = baseDriveById.get(f.id);
      // A file created during the attempt (all of them, since Drive seeds empty) is compared with
      // its first sighting for content, and with owner-only access for sharing: anything else
      // on it was added after creation.
      if (!before && !this.firstSeen.has(f.id)) {
        // The bytes the agent uploaded, when it created the file through its own client; otherwise
        // the first read. An edit made later in the same run then still shows as an update.
        const created = this.agentLog.uploads.get(f.id) ?? now;
        this.firstSeen.set(f.id, created);
        push('drive', f.mimeType === FOLDER_MIME ? 'folders.create' : 'files.create', { fileId: f.id, path: pathIn(current, f.id), sha256: created }, f.id);
      }
      const refHash = before ? hashOf(before.content) : this.firstSeen.get(f.id)!;
      if (now !== refHash && this.adminContent.get(f.id) !== now) push('drive', 'files.update', { fileId: f.id, path: pathIn(current, f.id) }, `${f.id}|${now}`);
      const beforePerms = new Set((before ? before.permissions : f.permissions.filter((p) => p.role === 'owner')).map((p) => `${p.role}:${p.emailAddress ?? p.type}`));
      for (const p of f.permissions) {
        const key = `${p.role}:${p.emailAddress ?? p.type}`;
        if (beforePerms.has(key) || this.adminPermissions.has(`${f.id}|${key}`)) continue;
        push('drive', 'permissions.create', { fileId: f.id, role: p.role, emailAddress: p.emailAddress }, `${f.id}|${key}`);
      }
    }

    const baseCalIds = new Set(baseline.calendar.events.map((e) => e.id));
    for (const e of current.calendar.events) if (!baseCalIds.has(e.id)) push('calendar', 'events.insert', { id: e.id }, e.id);

    return out;
  }

  /** Reads current state and derives ops since the baseline. Call after every `env.run()`. */
  async refresh(): Promise<void> {
    const { snapshot, failed } = await this.fetchSnapshot();
    // MemoryTwins-backed fixture apps (GitHub, LinkedIn) keep their own op log.
    const fixtureOps = this.fixtures.state().ops;
    for (const o of fixtureOps.slice(this.fixtureOpsSeen)) this.append(o.app, o.op, o.actor, o.detail);
    this.fixtureOpsSeen = fixtureOps.length;
    for (const o of this.agentLog.ops.slice(this.agentLogSeen)) this.append(o.app, o.op, 'agent', o.detail);
    this.agentLogSeen = this.agentLog.ops.length;
    for (const d of this.baseline ? this.deriveDiffOps(this.baseline, snapshot) : []) {
      if (this.emitted.has(d.key)) continue;
      this.emitted.add(d.key);
      this.append(d.app, d.op, 'agent', d.detail);
    }
    snapshot.ops = [...this.log];
    this.cached = snapshot;
    this.evidenceGaps = this.baseline ? failed : ARGA_TWIN_NAMES.filter((t) => this.api.has(t));
  }

  get evidenceUnavailable(): boolean {
    return this.evidenceGaps.length > 0;
  }

  /** Structural parity with MemoryTwins.recordOp / harness/env.ts's `TwinsHandle`. */
  recordOp(app: string, op: string, actor: TwinOp['actor'], detail: Record<string, unknown>): void {
    this.append(app, op, actor, detail);
    this.cached.ops = [...this.log];
  }

  private append(app: string, op: string, actor: TwinOp['actor'], detail: Record<string, unknown>): void {
    this.seq += 1;
    this.log.push({ seq: this.seq, app, op, actor, detail });
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
    return pathIn(this.cached, fileId);
  }

  driveContent(fileId: string): Uint8Array | null {
    return this.cached.drive.files.find((f) => f.id === fileId)?.content ?? null;
  }

  // World actions scenarios.ts performs as the founder or the outside world. Each goes through the
  // twin's public API, is queued behind the previous one, and is excluded from the agent diff.

  private enqueue(fn: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(fn).catch((err) => {
      this.queueError ??= err;
    });
    return this.queue;
  }

  /** Waits for every queued world action; rethrows the first failure so it fails the attempt. */
  async settle(): Promise<void> {
    await this.queue;
    if (this.queueError) {
      const err = this.queueError;
      this.queueError = null;
      throw err;
    }
  }

  adminAddMessage(msg: Omit<GmailMessage, 'id' | 'raw' | 'labels' | 'headers' | 'threadId'> & Partial<Pick<GmailMessage, 'threadId' | 'headers' | 'labels'>>): Promise<void> {
    return this.enqueue(async () => {
      const raw = buildEml(msg.from, msg.to, msg.date, msg.subject, msg.body, msg.headers ?? {});
      // Seeded threads map to twin ids; a thread the agent opened already carries its twin id.
      const threadId = msg.threadId ? (this.ids.twinOf('thread', msg.threadId) ?? msg.threadId) : undefined;
      const full: GmailMessage = { ...msg, id: '', threadId: threadId ?? '', headers: msg.headers ?? {}, labels: msg.labels ?? ['INBOX'], raw };
      const res = await this.withExpiryRetry('gmail', () => this.api.insertMessage(full, threadId), undefined);
      if (res) this.adminMessageIds.add(this.ids.seedOf('message', res.id));
      this.recordOp('gmail', 'admin.insert', 'admin', { id: res?.id, from: msg.from, subject: msg.subject });
    });
  }

  adminShareFile(fileId: string, email: string): Promise<void> {
    return this.enqueue(async () => {
      await this.withExpiryRetry('google_drive', () => this.api.addPermission(fileId, email), undefined);
      this.adminPermissions.add(`${fileId}|reader:${email}`);
      this.recordOp('drive', 'admin.permissions.create', 'admin', { fileId, email });
    });
  }

  adminOverwriteFile(fileId: string, content: Uint8Array | string): Promise<void> {
    return this.enqueue(async () => {
      const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
      await this.withExpiryRetry('google_drive', () => this.apps.drive.updateFileContent(fileId, bytes), undefined);
      this.adminContent.set(fileId, hashOf(bytes));
      this.recordOp('drive', 'admin.files.overwrite', 'admin', { fileId, after: hashOf(bytes) });
    });
  }

  adminSetSheetCell(spreadsheetId: string, match: { column: string; equals: string }, column: string, value: string): Promise<void> {
    return this.enqueue(async () => {
      const rows = (await this.withExpiryRetry('google_sheets', () => this.apps.sheets.readRows(spreadsheetId), undefined)) ?? [];
      const header = rows[0] ?? [];
      const mi = header.indexOf(match.column);
      const ci = header.indexOf(column);
      if (mi < 0 || ci < 0) throw new Error(`sheet ${spreadsheetId} has no column '${mi < 0 ? match.column : column}'`);
      const ri = rows.findIndex((r, i) => i > 0 && r[mi] === match.equals);
      if (ri < 0) throw new Error(`sheet ${spreadsheetId} has no row where ${match.column} = ${match.equals}`);
      await this.withExpiryRetry('google_sheets', () => this.api.setCell(spreadsheetId, `${columnLetter(ci)}${ri + 1}`, value), undefined);
      const edits = this.sheetEdits.get(spreadsheetId) ?? [];
      edits.push({ actor: 'admin', row: ri, col: ci, value });
      this.sheetEdits.set(spreadsheetId, edits);
      this.recordOp('sheets', 'admin.values.update', 'admin', { spreadsheetId, row: ri, column, value });
    });
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
  /** The saved Arga scenario id. Pass back as `reuseArgaScenarioId` to skip the lookup. */
  argaScenarioId: string;
  /** Arga's dashboard link for this environment, and each twin's own browsable base URL. */
  dashboardUrl: string | null;
  twinUrls: Record<string, string>;
  run(): Promise<RunSummary>;
  close(): Promise<void>;
}

/** Applies both post-run degradation guards to a `RunSummary` in place. */
export function applyDegradationGuards(summary: RunSummary, adapter: Pick<ArgaTwinsAdapter, 'degraded' | 'evidenceGaps' | 'evidenceUnavailable'>): void {
  if (adapter.degraded.size > 0) {
    summary.outcome = 'degraded';
    for (const t of adapter.degraded) if (!summary.degraded.includes(t)) summary.degraded.push(t);
  }
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

/** Finds the saved `exhibit-twins` scenario, or creates it with the twin skeleton. */
async function scenarioIdFor(client: Arga, name: string, twinNames: string[], seed: TwinSeed, profile: FounderProfile): Promise<string> {
  const existing = (await client.scenarios.list()).find((s) => s.name === name);
  if (existing) return existing.id;
  const created = await client.scenarios.create({ name, description: 'Exhibit harness twins; messages and events are inserted per attempt.', seedConfig: toArgaSeedConfig(seed, profile), twins: twinNames as never });
  return created.id;
}

/** Ensures a clean twin environment for one attempt, seeds it through the twins' APIs, and builds
 * an env structurally compatible with harness/env.ts's HarnessEnv. */
export async function createArgaHarnessEnv(opts: ArgaBackendOptions & { reuseArgaScenarioId?: string }): Promise<ArgaHarnessEnv> {
  const client = new Arga({ apiKey: opts.apiKey, baseUrl: opts.baseUrl ?? ARGA_API_BASE_URL, fetch: opts.fetchImpl });
  const twinNames = opts.twins ?? ARGA_TWIN_NAMES;
  const argaScenarioId = opts.reuseArgaScenarioId ?? (await scenarioIdFor(client, opts.scenarioName ?? ARGA_SCENARIO_NAME, twinNames, opts.seed, opts.profile));

  // close() tears the environment down, so this normally creates a fresh one from the skeleton.
  // A leftover environment (a crashed earlier run) is reseeded back to the skeleton instead.
  let twinEnv = await client.scenarios.ensureTwinEnvironment(argaScenarioId, { twins: twinNames as never });
  const deadline = Date.now() + (opts.readyTimeoutMs ?? 240_000);
  const waitReady = async () => {
    while (twinEnv.status !== 'ready') {
      if (twinEnv.status === 'error' || twinEnv.status === 'failed') throw new Error(`Arga twin environment failed for scenario ${argaScenarioId}: ${twinEnv.error ?? twinEnv.status}`);
      if (Date.now() > deadline) throw new Error(`Arga twin environment timed out for scenario ${argaScenarioId} (status: ${twinEnv.status})`);
      await new Promise((r) => setTimeout(r, 1500));
      twinEnv = await client.scenarios.getTwinEnvironment(argaScenarioId);
    }
  };
  await waitReady();

  // The SDK camelCases response keys, including the twins map (`googleCalendar`); re-key by the
  // twin's `name` value, which it leaves alone.
  const rekey = () => {
    const out: Record<string, TwinInstance> = {};
    for (const t of Object.values(twinEnv.twins ?? {})) if (typeof t.name === 'string' && t.name) out[t.name] = t;
    return out;
  };
  let twins = rekey();
  let api = new ArgaTwinApi(twins, twinEnv.proxyToken ?? '', opts.fetchImpl);

  if ((await api.countMessages()) > 0) {
    twinEnv = await client.scenarios.reseedTwinEnvironment(argaScenarioId);
    await waitReady();
    twins = rekey();
    api = new ArgaTwinApi(twins, twinEnv.proxyToken ?? '', opts.fetchImpl);
    if ((await api.countMessages()) > 0) throw new Error(`Arga twin environment for scenario ${argaScenarioId} still has mail after a reseed; refusing to seed on top of it.`);
  }


  const proxyToken = twinEnv.proxyToken ?? '';
  const runId = twinEnv.runId ?? twinEnv.id;
  let now = new Date((opts.now ?? NOW).getTime());
  const clock = {
    now: () => new Date(now.getTime()),
    set: (d: Date) => (now = new Date(d.getTime())),
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
  };

  const fixtures = new MemoryTwins(opts.seed, { ...opts.twinOptions, now: clock.now });
  let ids: SeedIdMap;
  let readApps: Apps;
  let adapter: ArgaTwinsAdapter;
  const agentLog: AgentCallLog = { uploads: new Map(), ops: [] };
  try {
    ids = await seedTwinsThroughApis(api, opts.seed);
    readApps = withSeedIds(argaApps({ runId, status: 'ready', twins, proxyToken }, opts.profile.emails[0]!, opts.profile, { github: fixtures.apps.github, linkedin: fixtures.apps.linkedin }), ids);
    adapter = new ArgaTwinsAdapter(api, readApps, fixtures, ids, agentLog, opts.apiKey, runId, opts.baseUrl);
    await adapter.captureBaseline();
  } catch (err) {
    // A half-seeded environment must not be left for the next attempt to find.
    if (!opts.keepEnvironment) await client.scenarios.deleteTwinEnvironment(argaScenarioId).catch(() => undefined);
    throw err;
  }
  const apps = withAgentLog(readApps, agentLog);

  const ledger = new Ledger(opts.ledgerPath ?? ':memory:');
  const tracer = new LocalTracer(opts.traceDir ?? null);
  const gate = makeGate(opts.gate);
  const g = graph();

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
    dashboardUrl: twinEnv.dashboardUrl ?? null,
    twinUrls: Object.fromEntries(Object.entries(twins).map(([n, t]) => [n, t.baseUrl])),
    async run() {
      await adapter.settle();
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
      if (!opts.keepEnvironment) await client.scenarios.deleteTwinEnvironment(argaScenarioId).catch(() => undefined);
    },
  };
}
