import { createHash } from 'node:crypto';
import http from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';

// A local stand-in for the Arga service, mirroring what the real service did when probed on
// 2026-09-13 (docs/ARGA.md). Everything listens on 127.0.0.1; nothing here talks to a real host.
//
// CONTROL PLANE (the `baseUrl` given to arga-sdk; paths from node_modules/arga-sdk/dist/index.js):
//   GET/POST /scenarios, POST|GET|DELETE /scenarios/:id/twin-environment,
//   POST /scenarios/:id/twin-environment/reseed, POST /validate/twins/provision/:runId/extend.
//   Responses are snake_case (the SDK camelCases them), including the `twins` map keys.
//
// TWINS: each twin gets its own origin (one server per twin), because googleapis rebuilds every
// non-upload request URL as `new URL('/gmail/v1/...', rootUrl)`, which drops any path prefix in a
// base URL (googleapis-common apirequest.js). Drive, Docs and Sheets share one store behind three
// base URLs. Each twin accepts only its own env-var token; the proxy token gets a 401.

export type TwinKey = 'gmail' | 'google_calendar' | 'google_drive' | 'google_docs' | 'google_sheets';
export const TWIN_KEYS: TwinKey[] = ['gmail', 'google_calendar', 'google_drive', 'google_docs', 'google_sheets'];

export const PROXY_TOKEN = 'proxy-tok-not-accepted-by-twins';
export const TWIN_TOKEN_VARS: Record<TwinKey, [string, string]> = {
  gmail: ['GMAIL_ACCESS_TOKEN', 'tok-gmail'],
  google_calendar: ['GOOGLE_CALENDAR_ACCESS_TOKEN', 'tok-cal'],
  google_drive: ['GOOGLE_ACCESS_TOKEN', 'tok-gws'],
  google_docs: ['GOOGLE_ACCESS_TOKEN', 'tok-gws'],
  google_sheets: ['GOOGLE_ACCESS_TOKEN', 'tok-gws'],
};

export const DOC_MIME = 'application/vnd.google-apps.document';
export const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface FakeMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  /** The decoded RFC 822 text. */
  raw: string;
}

export interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  content: Buffer;
  appProperties: Record<string, string>;
  createdTime: string;
  modifiedTime: string;
  permissions: { id: string; role: string; type: string; emailAddress?: string }[];
  trashed: boolean;
}

/** A forced response: the next `remaining` requests to `twin` whose method matches and whose
 * path+query matches `path` get `status` instead of being served. */
export interface Fault {
  twin: TwinKey;
  method?: string;
  path: RegExp;
  status: number;
  remaining: number;
}

export interface FakeArgaState {
  owner: string;
  scenarios: { id: string; name: string; description?: string; seed_config?: Record<string, unknown>; twins?: string[] }[];
  calls: { list: number; create: number; ensure: number; get: number; reseed: number; delete: number; extend: number };
  envExists: boolean;
  requestedTwins: TwinKey[];
  /** When true, a reseed leaves the mailbox as it was (a reseed that did not take). */
  reseedLeavesMail: boolean;
  gmail: FakeMessage[];
  events: Record<string, unknown>[];
  files: Map<string, FakeFile>;
  /** Google Docs body text, including the trailing newline every Docs body ends with. */
  docs: Map<string, string>;
  sheets: Map<string, string[][]>;
  faults: Fault[];
  /** Every twin request: which twin served it, method, path+query. */
  requests: { twin: TwinKey; method: string; path: string }[];
  /** Requests a twin rejected for a wrong token. */
  rejectedAuth: { twin: TwinKey; path: string; token: string }[];
  seq: number;
}

export interface FakeArga {
  /** Control-plane base URL, passed as `baseUrl` / `argaBaseUrl`. */
  url: string;
  twinUrls: Record<TwinKey, string>;
  state: FakeArgaState;
  nextId(prefix: string): string;
  /** Writes a message straight into the Gmail twin, as if a client other than the harness had. */
  putMessage(m: { raw: string; labelIds: string[]; threadId?: string }): FakeMessage;
  close(): Promise<void>;
}

const sha256hex = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function parseJson(body: Buffer): Record<string, unknown> {
  const text = body.toString('utf8');
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

/** Parses a `multipart/related` upload (googleapis-common: JSON metadata part, then media part). */
function parseMultipart(body: Buffer, contentType: string): { meta: Record<string, unknown>; media: Buffer } {
  const boundary = /boundary=([^;]+)/.exec(contentType)?.[1];
  if (!boundary) throw new Error('multipart upload without a boundary');
  const delim = Buffer.from(`--${boundary}`);
  const parts: Buffer[] = [];
  let at = body.indexOf(delim);
  while (at >= 0) {
    const start = at + delim.length;
    const next = body.indexOf(delim, start);
    if (next < 0) break;
    parts.push(body.subarray(start, next));
    at = next;
  }
  const bodyOf = (part: Buffer): Buffer => {
    let p = part;
    if (p.subarray(0, 2).toString() === '\r\n') p = p.subarray(2);
    const split = p.indexOf('\r\n\r\n');
    let b = p.subarray(split + 4);
    if (b.subarray(b.length - 2).toString() === '\r\n') b = b.subarray(0, b.length - 2);
    return b;
  };
  if (parts.length < 2) throw new Error(`multipart upload has ${parts.length} parts`);
  return { meta: JSON.parse(bodyOf(parts[0]!).toString('utf8')) as Record<string, unknown>, media: Buffer.from(bodyOf(parts[1]!)) };
}

/** A1 cell (`B3`, `A1`, `A:A`, `A:K`) to a zero-based top-left. */
function topLeft(range: string): { row: number; col: number } {
  const m = /^([A-Z]+)(\d+)?/.exec(range.replace(/^.*!/, ''));
  if (!m) return { row: 0, col: 0 };
  let col = 0;
  for (const ch of m[1]!) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: m[2] ? Number(m[2]) - 1 : 0, col: col - 1 };
}

export async function startFakeArga(opts: { owner: string }): Promise<FakeArga> {
  const state: FakeArgaState = {
    owner: opts.owner,
    scenarios: [],
    calls: { list: 0, create: 0, ensure: 0, get: 0, reseed: 0, delete: 0, extend: 0 },
    envExists: false,
    requestedTwins: [...TWIN_KEYS],
    reseedLeavesMail: false,
    gmail: [],
    events: [],
    files: new Map(),
    docs: new Map(),
    sheets: new Map(),
    faults: [],
    requests: [],
    rejectedAuth: [],
    seq: 0,
  };
  const nextId = (prefix: string) => `${prefix}_${(state.seq += 1)}`;
  const now = () => new Date().toISOString();

  const wipeTwins = () => {
    state.gmail = [];
    state.events = [];
    state.files = new Map();
    state.docs = new Map();
    state.sheets = new Map();
  };

  const putMessage = (m: { raw: string; labelIds: string[]; threadId?: string }): FakeMessage => {
    const id = nextId('gm');
    const msg: FakeMessage = { id, threadId: m.threadId || id, labelIds: m.labelIds, raw: m.raw };
    state.gmail.push(msg);
    return msg;
  };

  const fileMeta = (f: FakeFile) => ({
    kind: 'drive#file',
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    parents: f.parents,
    ...(f.mimeType === FOLDER_MIME || f.mimeType === DOC_MIME || f.mimeType === SHEET_MIME ? {} : { size: String(f.content.length), sha256Checksum: sha256hex(f.content) }),
    createdTime: f.createdTime,
    modifiedTime: f.modifiedTime,
    appProperties: f.appProperties,
  });

  const newFile = (meta: Record<string, unknown>, content: Buffer): FakeFile => {
    const t = now();
    const f: FakeFile = {
      id: nextId('file'),
      name: String(meta.name ?? 'Untitled'),
      mimeType: String(meta.mimeType ?? 'application/octet-stream'),
      parents: (meta.parents as string[] | undefined) ?? ['root'],
      content,
      appProperties: (meta.appProperties as Record<string, string> | undefined) ?? {},
      createdTime: t,
      modifiedTime: t,
      permissions: [{ id: nextId('perm'), role: 'owner', type: 'user', emailAddress: state.owner }],
      trashed: false,
    };
    state.files.set(f.id, f);
    return f;
  };

  // ---------- twins ----------
  const servers: Server[] = [];
  const twinUrls = {} as Record<TwinKey, string>;

  const serveTwin = (twin: TwinKey) => async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req);
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    const p = url.pathname;
    state.requests.push({ twin, method, path: `${p}${url.search}` });

    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (token !== TWIN_TOKEN_VARS[twin][1]) {
      state.rejectedAuth.push({ twin, path: p, token });
      return json(res, 401, { error: { code: 401, message: 'Request had invalid authentication credentials.' } });
    }
    if (!state.envExists) return json(res, 410, { error: { code: 410, message: 'twin environment expired' } });
    const fault = state.faults.find((f) => f.twin === twin && f.remaining > 0 && (!f.method || f.method === method) && f.path.test(`${p}${url.search}`));
    if (fault) {
      fault.remaining -= 1;
      return json(res, fault.status, { error: { code: fault.status, message: 'forced by test' } });
    }

    try {
      if (twin === 'gmail') {
        const base = '/gmail/v1/users/me/messages';
        if (method === 'GET' && p === base) {
          const all = [...state.gmail].reverse();
          const offset = Number(url.searchParams.get('pageToken') ?? 0);
          const max = Number(url.searchParams.get('maxResults') ?? 100);
          const page = all.slice(offset, offset + max);
          const next = offset + max < all.length ? String(offset + max) : undefined;
          return json(res, 200, { messages: page.map((m) => ({ id: m.id, threadId: m.threadId })), resultSizeEstimate: all.length, ...(next ? { nextPageToken: next } : {}) });
        }
        if (method === 'POST' && (p === base || p === `${base}/send`)) {
          const b = parseJson(body);
          const raw = Buffer.from(String(b.raw ?? ''), 'base64url').toString('utf8');
          const labelIds = p === base ? ((b.labelIds as string[] | undefined) ?? ['INBOX']) : ['SENT'];
          const m = putMessage({ raw, labelIds, threadId: b.threadId as string | undefined });
          return json(res, 200, { id: m.id, threadId: m.threadId, labelIds: m.labelIds });
        }
        const one = new RegExp(`^${base}/([^/]+)$`).exec(p);
        if (method === 'GET' && one) {
          const m = state.gmail.find((x) => x.id === decodeURIComponent(one[1]!));
          if (!m) return json(res, 404, { error: { code: 404, message: 'Requested entity was not found.' } });
          return json(res, 200, { id: m.id, threadId: m.threadId, labelIds: m.labelIds, raw: Buffer.from(m.raw, 'utf8').toString('base64url') });
        }
      }

      if (twin === 'google_calendar') {
        const base = '/calendar/v3/calendars/primary/events';
        if (method === 'GET' && p === base) {
          const items = [...state.events].sort((a, b) => String((a.start as { dateTime?: string })?.dateTime).localeCompare(String((b.start as { dateTime?: string })?.dateTime)));
          return json(res, 200, { kind: 'calendar#events', items, nextPageToken: null });
        }
        if (method === 'POST' && p === base) {
          const ev = { kind: 'calendar#event', ...parseJson(body), id: nextId('ev'), updated: now(), htmlLink: 'https://calendar.twin.example/event' };
          state.events.push(ev);
          return json(res, 200, ev);
        }
      }

      if (twin === 'google_drive') {
        if (method === 'GET' && p === '/drive/v3/files') {
          const q = url.searchParams.get('q') ?? '';
          const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\(.)/g, '$1');
          const parent = /'([^']+)' in parents/.exec(q)?.[1];
          let files = [...state.files.values()].filter((f) => !f.trashed);
          if (name !== undefined) files = files.filter((f) => f.name === name);
          if (parent !== undefined) files = files.filter((f) => f.parents.includes(parent));
          const pageSize = Number(url.searchParams.get('pageSize') ?? 1000);
          return json(res, 200, { kind: 'drive#fileList', files: files.slice(0, pageSize).map(fileMeta), nextPageToken: null });
        }
        if (method === 'POST' && p === '/drive/v3/files') return json(res, 200, fileMeta(newFile(parseJson(body), Buffer.alloc(0))));
        if (method === 'POST' && p === '/upload/drive/v3/files') {
          const { meta, media } = parseMultipart(body, String(req.headers['content-type'] ?? ''));
          return json(res, 200, fileMeta(newFile(meta, media)));
        }
        const upd = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(p);
        if (method === 'PATCH' && upd) {
          const f = state.files.get(decodeURIComponent(upd[1]!));
          if (!f) return json(res, 404, { error: { code: 404, message: 'File not found' } });
          if (url.searchParams.get('uploadType') === 'multipart') {
            const { meta, media } = parseMultipart(body, String(req.headers['content-type'] ?? ''));
            if (meta.name) f.name = String(meta.name);
            f.content = media;
          } else {
            f.content = body;
          }
          f.modifiedTime = now();
          return json(res, 200, fileMeta(f));
        }
        const perms = /^\/drive\/v3\/files\/([^/]+)\/permissions$/.exec(p);
        if (perms) {
          const f = state.files.get(decodeURIComponent(perms[1]!));
          if (!f) return json(res, 404, { error: { code: 404, message: 'File not found' } });
          if (method === 'GET') return json(res, 200, { kind: 'drive#permissionList', permissions: f.permissions });
          if (method === 'POST') {
            const b = parseJson(body);
            const perm = { id: nextId('perm'), role: String(b.role ?? 'reader'), type: String(b.type ?? 'user'), emailAddress: b.emailAddress as string | undefined };
            f.permissions.push(perm);
            return json(res, 200, perm);
          }
        }
        const one = /^\/drive\/v3\/files\/([^/]+)$/.exec(p);
        if (one) {
          const f = state.files.get(decodeURIComponent(one[1]!));
          if (!f) return json(res, 404, { error: { code: 404, message: 'File not found' } });
          if (method === 'GET' && url.searchParams.get('alt') === 'media') {
            res.writeHead(200, { 'content-type': 'application/octet-stream' });
            return res.end(f.content);
          }
          if (method === 'GET') return json(res, 200, fileMeta(f));
          if (method === 'PATCH') {
            const add = url.searchParams.get('addParents');
            const remove = url.searchParams.get('removeParents');
            if (remove) f.parents = f.parents.filter((x) => !remove.split(',').includes(x));
            if (add) f.parents.push(...add.split(','));
            const b = parseJson(body);
            if (b.name) f.name = String(b.name);
            f.modifiedTime = now();
            return json(res, 200, fileMeta(f));
          }
        }
      }

      if (twin === 'google_docs') {
        if (method === 'POST' && p === '/v1/documents') {
          const title = String(parseJson(body).title ?? 'Untitled document');
          const f = newFile({ name: title, mimeType: DOC_MIME }, Buffer.alloc(0));
          state.docs.set(f.id, '\n');
          return json(res, 200, { documentId: f.id, title });
        }
        const batch = /^\/v1\/documents\/([^/]+):batchUpdate$/.exec(p);
        if (method === 'POST' && batch) {
          const id = decodeURIComponent(batch[1]!);
          let text = state.docs.get(id);
          if (text === undefined) return json(res, 404, { error: { code: 404, message: 'Document not found' } });
          for (const r of (parseJson(body).requests as Record<string, { range?: { startIndex: number; endIndex: number }; location?: { index: number }; text?: string }>[]) ?? []) {
            if (r.deleteContentRange?.range) text = text.slice(0, r.deleteContentRange.range.startIndex - 1) + text.slice(r.deleteContentRange.range.endIndex - 1);
            if (r.insertText?.location) text = text.slice(0, r.insertText.location.index - 1) + (r.insertText.text ?? '') + text.slice(r.insertText.location.index - 1);
          }
          state.docs.set(id, text);
          return json(res, 200, { documentId: id, replies: [] });
        }
        const one = /^\/v1\/documents\/([^/:]+)$/.exec(p);
        if (method === 'GET' && one) {
          const id = decodeURIComponent(one[1]!);
          const text = state.docs.get(id);
          if (text === undefined) return json(res, 404, { error: { code: 404, message: 'Document not found' } });
          const end = 1 + text.length;
          return json(res, 200, {
            documentId: id,
            title: state.files.get(id)?.name ?? '',
            body: { content: [{ endIndex: 1, sectionBreak: {} }, { startIndex: 1, endIndex: end, paragraph: { elements: [{ startIndex: 1, endIndex: end, textRun: { content: text } }] } }] },
          });
        }
      }

      if (twin === 'google_sheets') {
        if (method === 'POST' && p === '/v4/spreadsheets') {
          const title = String((parseJson(body).properties as { title?: string } | undefined)?.title ?? 'Untitled spreadsheet');
          const f = newFile({ name: title, mimeType: SHEET_MIME }, Buffer.alloc(0));
          state.sheets.set(f.id, []);
          return json(res, 200, { spreadsheetId: f.id, properties: { title } });
        }
        const values = /^\/v4\/spreadsheets\/([^/]+)\/values\/([^/]+?)(:append)?$/.exec(p);
        if (values) {
          const id = decodeURIComponent(values[1]!);
          const range = decodeURIComponent(values[2]!);
          const rows = state.sheets.get(id);
          if (!rows) return json(res, 404, { error: { code: 404, message: 'Spreadsheet not found' } });
          if (method === 'GET') return json(res, 200, { range, majorDimension: 'ROWS', ...(rows.length ? { values: rows } : {}) });
          const incoming = ((parseJson(body).values as unknown[][] | undefined) ?? []).map((r) => r.map((c) => String(c)));
          if (method === 'POST' && values[3]) {
            rows.push(...incoming);
            return json(res, 200, { spreadsheetId: id, updates: { updatedRows: incoming.length } });
          }
          if (method === 'PUT') {
            const { row, col } = topLeft(range);
            incoming.forEach((r, i) => {
              while (rows.length <= row + i) rows.push([]);
              const target = rows[row + i]!;
              r.forEach((v, j) => {
                while (target.length <= col + j) target.push('');
                target[col + j] = v;
              });
            });
            return json(res, 200, { spreadsheetId: id, updatedRange: range });
          }
        }
      }
    } catch (err) {
      return json(res, 400, { error: { code: 400, message: String(err) } });
    }
    return json(res, 404, { error: { code: 404, message: `fake ${twin} has no route for ${method} ${p}` } });
  };

  for (const twin of TWIN_KEYS) {
    const srv = http.createServer((req, res) => void serveTwin(twin)(req, res));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    servers.push(srv);
    twinUrls[twin] = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  }

  // ---------- control plane ----------
  const envPayload = (scenarioId: string) => ({
    id: `env_${scenarioId}`,
    scenario_id: scenarioId,
    status: 'ready',
    run_id: `run_${scenarioId}`,
    proxy_token: PROXY_TOKEN,
    dashboard_url: `https://app.arga.example/environments/env_${scenarioId}`,
    twins: Object.fromEntries(
      state.requestedTwins.map((t) => [t, { name: t, base_url: twinUrls[t], admin_url: `${twinUrls[t]}/admin`, env_vars: { [TWIN_TOKEN_VARS[t][0]]: TWIN_TOKEN_VARS[t][1] } }]),
    ),
  });

  const control = http.createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const method = req.method ?? 'GET';
      const p = url.pathname;
      if (req.headers.authorization !== 'Bearer arga_sk_test') return json(res, 401, { detail: 'Invalid API key' });

      if (p === '/scenarios' && method === 'GET') {
        state.calls.list += 1;
        return json(res, 200, state.scenarios);
      }
      if (p === '/scenarios' && method === 'POST') {
        state.calls.create += 1;
        const b = parseJson(body);
        const s = { id: `scn_${state.scenarios.length + 1}`, name: String(b.name), description: b.description as string | undefined, seed_config: b.seed_config as Record<string, unknown>, twins: b.twins as string[] };
        state.scenarios.push(s);
        return json(res, 200, s);
      }
      const envPath = /^\/scenarios\/([^/]+)\/twin-environment(\/reseed)?$/.exec(p);
      if (envPath) {
        const id = decodeURIComponent(envPath[1]!);
        if (!state.scenarios.some((s) => s.id === id)) return json(res, 404, { detail: 'Scenario not found' });
        if (envPath[2] && method === 'POST') {
          state.calls.reseed += 1;
          if (!state.reseedLeavesMail) wipeTwins();
          return json(res, 200, envPayload(id));
        }
        if (method === 'POST') {
          state.calls.ensure += 1;
          const asked = parseJson(body).twins as string[] | undefined;
          if (!state.envExists) {
            wipeTwins();
            state.envExists = true;
            state.requestedTwins = asked ? TWIN_KEYS.filter((t) => asked.includes(t)) : [...TWIN_KEYS];
          }
          return json(res, 200, envPayload(id));
        }
        if (method === 'GET') {
          state.calls.get += 1;
          return state.envExists ? json(res, 200, envPayload(id)) : json(res, 404, { detail: 'No twin environment' });
        }
        if (method === 'DELETE') {
          state.calls.delete += 1;
          state.envExists = false;
          wipeTwins();
          return json(res, 200, { id: `env_${id}`, status: 'deleted' });
        }
      }
      const ext = /^\/validate\/twins\/provision\/([^/]+)\/extend$/.exec(p);
      if (ext && method === 'POST') {
        state.calls.extend += 1;
        return json(res, 200, { run_id: decodeURIComponent(ext[1]!), expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      }
      return json(res, 404, { detail: `fake control plane has no route for ${method} ${p}` });
    })();
  });
  await new Promise<void>((r) => control.listen(0, '127.0.0.1', r));
  servers.push(control);

  return {
    url: `http://127.0.0.1:${(control.address() as AddressInfo).port}`,
    twinUrls,
    state,
    nextId,
    putMessage,
    close: async () => {
      await Promise.all(
        servers.map(
          (s) =>
            new Promise<void>((r) => {
              s.closeAllConnections?.();
              s.close(() => r());
            }),
        ),
      );
    },
  };
}

/** Blocks every outbound request that is not to 127.0.0.1 / localhost: global `fetch` (arga-sdk,
 * the harness's raw twin calls) and node's http/https request (node-fetch, which googleapis uses
 * through gaxios). A blocked request fails immediately and is recorded, so a call that escaped to
 * www.googleapis.com or api.argalabs.com makes the test fail instead of hanging or leaving the
 * machine. */
export function installNetworkGuard(): { blocked: string[]; restore(): void } {
  const blocked: string[] = [];
  const loopback = (host: string | null | undefined) => !host || /^(127\.0\.0\.1|localhost|\[?::1\]?)(:\d+)?$/.test(host);
  const hostOf = (target: unknown): string | undefined => {
    if (typeof target === 'string') return new URL(target).host;
    if (target instanceof URL) return target.host;
    const o = target as { hostname?: string; host?: string } | undefined;
    return o?.hostname ?? o?.host;
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!loopback(new URL(u).host)) {
      blocked.push(u);
      throw new Error(`network guard: blocked fetch to ${u}`);
    }
    return origFetch(input, init);
  }) as typeof fetch;

  const origHttp = http.request;
  const origHttps = https.request;
  (http as { request: unknown }).request = (...args: unknown[]) => {
    const host = hostOf(args[0]);
    if (!loopback(host)) {
      blocked.push(`http://${host}`);
      throw new Error(`network guard: blocked http request to ${host}`);
    }
    return (origHttp as (...a: unknown[]) => unknown)(...args);
  };
  (https as { request: unknown }).request = (...args: unknown[]) => {
    const host = hostOf(args[0]);
    blocked.push(`https://${host}`);
    throw new Error(`network guard: blocked https request to ${host}`);
  };

  return {
    blocked,
    restore() {
      globalThis.fetch = origFetch;
      (http as { request: unknown }).request = origHttp;
      (https as { request: unknown }).request = origHttps;
    },
  };
}
