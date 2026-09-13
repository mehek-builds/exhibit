import type {
  Apps,
  CalendarEvent,
  DriveFile,
  DrivePermission,
  GithubRepo,
  GithubReview,
  GmailMessage,
  LinkedinPost,
  OutgoingEmail,
} from '../apps/types.js';
import { AppUnavailableError, FOLDER_MIME, TwinExpiredError } from '../apps/types.js';
import { sha256 } from '../util.js';

// Stateful in-memory twins of the seven apps. They mirror what the harness reads from an
// Arga twin's `GET <admin_url>/admin/state?full=1`: every write is an op with an actor,
// so the grader works from end state and ops, never from the agent's own log (PRD 12.3).

export interface TwinSeed {
  owner: string;
  gmail: GmailMessage[];
  calendar: CalendarEvent[];
  github: Record<string, { repos: GithubRepo[]; reviews: GithubReview[] }>;
  linkedin: { posts: LinkedinPost[]; followers: number } | null;
}

/** JSON-serializable form of MemoryTwins's internal state, for mock-mode persistence across CLI invocations. */
export interface MemoryTwinsSnapshot {
  gmail: GmailMessage[];
  calendar: CalendarEvent[];
  github: TwinSeed['github'];
  linkedin: TwinSeed['linkedin'];
  drive: { id: string; meta: DriveFile; content: string; permissions: DrivePermission[] }[];
  docs: { id: string; title: string; text: string }[];
  sheets: { id: string; title: string; rows: string[][]; edits: { actor: 'agent' | 'admin'; row: number; col: number; value: string }[] }[];
  ops: TwinOp[];
  stubHits: string[];
  seq: number;
  ids: number;
}

export interface TwinOp {
  seq: number;
  /** The seven app twins, 'arga' for provisioning calls, and any fake added beside them (twilio, dropboxsign, ...). */
  app: string;
  op: string;
  actor: 'agent' | 'admin';
  detail: Record<string, unknown>;
}

interface DriveEntry {
  meta: DriveFile;
  content: Uint8Array;
  permissions: DrivePermission[];
}

export interface TwinOptions {
  now: () => Date;
  linkedinUnavailable?: boolean;
  /** Simulate a lapsed TTL: the next N calls to this app return 410. */
  expire?: { app: TwinOp['app']; failures: number };
}

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryTwins {
  readonly backend = 'memory';
  ops: TwinOp[] = [];
  stubHits: string[] = [];
  private seq = 0;
  private ids = 0;
  private gmail: GmailMessage[] = [];
  private calendar: CalendarEvent[] = [];
  private github: TwinSeed['github'] = {};
  private linkedin: TwinSeed['linkedin'] = null;
  private drive = new Map<string, DriveEntry>();
  private docs = new Map<string, { title: string; text: string }>();
  private sheets = new Map<string, { title: string; rows: string[][]; edits: { actor: 'agent' | 'admin'; row: number; col: number; value: string }[] }>();
  private expireLeft = 0;
  readonly apps: Apps;

  constructor(
    private readonly seed: TwinSeed,
    private readonly opts: TwinOptions,
  ) {
    this.load();
    this.apps = this.buildApps();
  }

  get owner(): string {
    return this.seed.owner;
  }

  private load(): void {
    this.gmail = clone(this.seed.gmail);
    this.calendar = clone(this.seed.calendar);
    this.github = clone(this.seed.github);
    this.linkedin = clone(this.seed.linkedin);
    this.drive = new Map();
    this.docs = new Map();
    this.sheets = new Map();
    this.ops = [];
    this.stubHits = [];
    this.seq = 0;
    this.ids = 0;
    this.expireLeft = this.opts.expire?.failures ?? 0;
  }

  /** Back to the seed state captured at provision time (`twins.reset`). */
  reset(): void {
    this.load();
  }

  /** `twins.extend`: records the call; a twin that is truly gone keeps failing. */
  async extend(): Promise<void> {
    this.record('arga', 'twins.extend', 'agent', {});
  }

  private nextId(prefix: string): string {
    this.ids += 1;
    return `${prefix}_${String(this.ids).padStart(4, '0')}`;
  }

  private record(app: TwinOp['app'], op: string, actor: TwinOp['actor'], detail: Record<string, unknown>): void {
    this.seq += 1;
    this.ops.push({ seq: this.seq, app, op, actor, detail });
  }

  /** For fakes added beside the twins (Twilio, Dropbox Sign, ...): their writes join the op log the grader reads. */
  recordOp(app: string, op: string, actor: TwinOp['actor'], detail: Record<string, unknown>): void {
    this.record(app, op, actor, detail);
  }

  private gate(app: TwinOp['app']): void {
    if (this.opts.expire?.app === app && this.expireLeft > 0) {
      this.expireLeft -= 1;
      throw new TwinExpiredError(app);
    }
  }

  // ----- admin surface (the harness acting as the founder or the world) -----

  adminAddMessage(msg: Omit<GmailMessage, 'id' | 'raw' | 'labels' | 'headers' | 'threadId'> & Partial<Pick<GmailMessage, 'threadId' | 'headers' | 'labels'>>): GmailMessage {
    const id = this.nextId('msg_admin');
    const full: GmailMessage = {
      id,
      threadId: msg.threadId ?? id,
      from: msg.from,
      to: msg.to,
      date: msg.date,
      subject: msg.subject,
      body: msg.body,
      headers: msg.headers ?? {},
      labels: msg.labels ?? ['INBOX'],
      raw: buildEml(msg.from, msg.to, msg.date, msg.subject, msg.body, msg.headers ?? {}),
    };
    this.gmail.push(full);
    this.record('gmail', 'admin.insert', 'admin', { id, from: msg.from, subject: msg.subject });
    return full;
  }

  adminShareFile(fileId: string, email: string): void {
    const f = this.drive.get(fileId);
    if (!f) throw new Error(`no file ${fileId}`);
    f.permissions.push({ id: this.nextId('perm'), role: 'reader', type: 'user', emailAddress: email });
    this.record('drive', 'admin.permissions.create', 'admin', { fileId, email });
  }

  /** The world tampering with a filed file (S22): recorded as an admin op, never as the agent's. */
  adminOverwriteFile(fileId: string, content: Uint8Array | string): void {
    const f = this.drive.get(fileId);
    if (!f) throw new Error(`no file ${fileId}`);
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    f.content = bytes;
    f.meta.sha256 = sha256(bytes);
    f.meta.size = bytes.byteLength;
    this.record('drive', 'admin.files.overwrite', 'admin', { fileId, path: this.drivePath(fileId), after: f.meta.sha256 });
  }

  adminSheetByTitle(title: string): string | null {
    for (const [id, s] of this.sheets) if (s.title === title) return id;
    return null;
  }

  adminSetSheetCell(spreadsheetId: string, match: { column: string; equals: string }, column: string, value: string): void {
    const s = this.sheets.get(spreadsheetId);
    if (!s) throw new Error(`no sheet ${spreadsheetId}`);
    const header = s.rows[0] ?? [];
    const mc = header.indexOf(match.column);
    const tc = header.indexOf(column);
    const r = s.rows.findIndex((row, i) => i > 0 && row[mc] === match.equals);
    if (mc < 0 || tc < 0 || r < 0) throw new Error(`no row where ${match.column} = ${match.equals}`);
    const row = s.rows[r]!;
    while (row.length <= tc) row.push('');
    row[tc] = value;
    s.edits.push({ actor: 'admin', row: r, col: tc, value });
    this.record('sheets', 'admin.values.update', 'admin', { spreadsheetId, row: r, column, value });
  }

  /** Full twin state, the analogue of `/admin/state?full=1`. */
  state() {
    return {
      gmail: { messages: clone(this.gmail) },
      calendar: { events: clone(this.calendar) },
      drive: {
        files: [...this.drive.values()].map((f) => ({ ...clone(f.meta), permissions: clone(f.permissions), content: Buffer.from(f.content) })),
      },
      docs: [...this.docs].map(([id, d]) => ({ documentId: id, ...clone(d) })),
      sheets: [...this.sheets].map(([id, s]) => ({ spreadsheetId: id, ...clone(s) })),
      linkedin: clone(this.linkedin),
      ops: clone(this.ops),
      stubHits: [...this.stubHits],
    };
  }

  /**
   * Full internal state as a JSON-serializable snapshot (mock-mode persistence, src/mock/deps.ts):
   * unlike `state()`, drive content is base64 (not a Buffer) so `JSON.stringify` round-trips it.
   */
  snapshot(): MemoryTwinsSnapshot {
    return {
      gmail: clone(this.gmail),
      calendar: clone(this.calendar),
      github: clone(this.github),
      linkedin: clone(this.linkedin),
      drive: [...this.drive.entries()].map(([id, f]) => ({
        id,
        meta: clone(f.meta),
        content: Buffer.from(f.content).toString('base64'),
        permissions: clone(f.permissions),
      })),
      docs: [...this.docs.entries()].map(([id, d]) => ({ id, ...clone(d) })),
      sheets: [...this.sheets.entries()].map(([id, s]) => ({ id, ...clone(s) })),
      ops: clone(this.ops),
      stubHits: [...this.stubHits],
      seq: this.seq,
      ids: this.ids,
    };
  }

  /** Restores state written by `snapshot()`; replaces the seed-derived state entirely. */
  restore(snapshot: MemoryTwinsSnapshot): void {
    this.gmail = clone(snapshot.gmail);
    this.calendar = clone(snapshot.calendar);
    this.github = clone(snapshot.github);
    this.linkedin = clone(snapshot.linkedin);
    this.drive = new Map(
      snapshot.drive.map((f) => [f.id, { meta: clone(f.meta), content: Buffer.from(f.content, 'base64'), permissions: clone(f.permissions) }]),
    );
    this.docs = new Map(snapshot.docs.map((d) => [d.id, { title: d.title, text: d.text }]));
    this.sheets = new Map(snapshot.sheets.map((s) => [s.id, { title: s.title, rows: clone(s.rows), edits: clone(s.edits) }]));
    this.ops = clone(snapshot.ops);
    this.stubHits = [...snapshot.stubHits];
    this.seq = snapshot.seq;
    this.ids = snapshot.ids;
  }

  drivePath(fileId: string): string {
    const parts: string[] = [];
    let cur = this.drive.get(fileId);
    while (cur) {
      parts.unshift(cur.meta.name);
      const parent = cur.meta.parents[0];
      cur = parent && parent !== 'root' ? this.drive.get(parent) : undefined;
    }
    return parts.join('/');
  }

  driveContent(fileId: string): Uint8Array | null {
    return this.drive.get(fileId)?.content ?? null;
  }

  // ----- the app surface the agent uses -----

  private buildApps(): Apps {
    const twin = this;
    return {
      gmail: {
        async listMessages() {
          twin.gate('gmail');
          twin.record('gmail', 'messages.list', 'agent', {});
          return clone(twin.gmail.filter((m) => !m.labels.includes('SPAM') && !m.labels.includes('TRASH')).sort((a, b) => Date.parse(a.date) - Date.parse(b.date)));
        },
        async send(email: OutgoingEmail) {
          twin.gate('gmail');
          const id = twin.nextId('msg_sent');
          const date = twin.opts.now().toUTCString();
          const headers: Record<string, string> = email.inReplyTo ? { 'In-Reply-To': email.inReplyTo } : {};
          twin.gmail.push({
            id,
            threadId: email.threadId ?? id,
            from: twin.seed.owner,
            to: email.to,
            date,
            subject: email.subject,
            body: email.body,
            headers,
            labels: ['SENT'],
            raw: buildEml(twin.seed.owner, email.to, date, email.subject, email.body, headers),
          });
          twin.record('gmail', 'messages.send', 'agent', { id, to: email.to, subject: email.subject, body: email.body });
          return { id, threadId: email.threadId ?? id };
        },
      },
      calendar: {
        async listEvents() {
          twin.gate('calendar');
          twin.record('calendar', 'events.list', 'agent', {});
          return clone(twin.calendar);
        },
      },
      drive: {
        async findChild(parentId, name) {
          twin.gate('drive');
          const parent = parentId ?? 'root';
          for (const f of twin.drive.values()) if (f.meta.parents.includes(parent) && f.meta.name === name) return clone(f.meta);
          return null;
        },
        async createFolder(parentId, name) {
          twin.gate('drive');
          return twin.createDriveEntry(parentId ?? 'root', name, FOLDER_MIME, new Uint8Array(), {});
        },
        async createFile({ parentId, name, mimeType, content, appProperties }) {
          twin.gate('drive');
          const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
          return twin.createDriveEntry(parentId, name, mimeType, bytes, appProperties ?? {});
        },
        async updateFileContent(fileId, content) {
          twin.gate('drive');
          const f = twin.drive.get(fileId);
          if (!f) throw new Error(`404 file ${fileId}`);
          const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
          const before = f.meta.sha256;
          f.content = bytes;
          f.meta.sha256 = sha256(bytes);
          f.meta.size = bytes.byteLength;
          f.meta.modifiedTime = twin.opts.now().toISOString();
          twin.record('drive', 'files.update', 'agent', { fileId, path: twin.drivePath(fileId), before, after: f.meta.sha256 });
          return clone(f.meta);
        },
        async moveFile(fileId, fromParentId, toParentId) {
          twin.gate('drive');
          const f = twin.drive.get(fileId);
          if (!f) throw new Error(`404 file ${fileId}`);
          f.meta.parents = f.meta.parents.filter((p) => p !== fromParentId).concat(toParentId);
          twin.record('drive', 'files.move', 'agent', { fileId, from: fromParentId, to: toParentId, path: twin.drivePath(fileId) });
          return clone(f.meta);
        },
        async readFile(fileId) {
          twin.gate('drive');
          const f = twin.drive.get(fileId);
          if (!f) throw new Error(`404 file ${fileId}`);
          return new Uint8Array(f.content);
        },
        async listChildren(parentId) {
          twin.gate('drive');
          return [...twin.drive.values()].filter((f) => f.meta.parents.includes(parentId)).map((f) => clone(f.meta));
        },
        async listPermissions(fileId) {
          twin.gate('drive');
          const f = twin.drive.get(fileId);
          if (!f) throw new Error(`404 file ${fileId}`);
          return clone(f.permissions);
        },
      },
      docs: {
        async create(title) {
          twin.gate('docs');
          const id = twin.nextId('doc');
          twin.docs.set(id, { title, text: '' });
          twin.record('docs', 'documents.create', 'agent', { documentId: id, title });
          return { documentId: id };
        },
        async replaceText(documentId, text) {
          twin.gate('docs');
          const d = twin.docs.get(documentId);
          if (!d) throw new Error(`404 doc ${documentId}`);
          d.text = text;
          twin.record('docs', 'documents.batchUpdate', 'agent', { documentId, length: text.length });
        },
        async getText(documentId) {
          twin.gate('docs');
          const d = twin.docs.get(documentId);
          if (!d) throw new Error(`404 doc ${documentId}`);
          return d.text;
        },
      },
      sheets: {
        async create(title, headers) {
          twin.gate('sheets');
          const id = twin.nextId('sheet');
          twin.sheets.set(id, { title, rows: [headers], edits: [] });
          twin.record('sheets', 'spreadsheets.create', 'agent', { spreadsheetId: id, title });
          return { spreadsheetId: id };
        },
        async appendRows(spreadsheetId, rows) {
          twin.gate('sheets');
          const s = twin.sheets.get(spreadsheetId);
          if (!s) throw new Error(`404 sheet ${spreadsheetId}`);
          for (const row of rows) s.rows.push([...row]);
          twin.record('sheets', 'values.append', 'agent', { spreadsheetId, rows: rows.length });
        },
        async readRows(spreadsheetId) {
          twin.gate('sheets');
          const s = twin.sheets.get(spreadsheetId);
          if (!s) throw new Error(`404 sheet ${spreadsheetId}`);
          return clone(s.rows);
        },
      },
      github: {
        async listReposFor(login) {
          twin.gate('github');
          twin.record('github', 'repos.listForUser', 'agent', { login });
          return clone(twin.github[login]?.repos ?? []);
        },
        async listReviewsBy(login) {
          twin.gate('github');
          twin.record('github', 'search.reviews', 'agent', { login });
          return clone(twin.github[login]?.reviews ?? []);
        },
      },
      linkedin: {
        async listMentions(profileId) {
          if (twin.opts.linkedinUnavailable || !twin.linkedin) throw new AppUnavailableError('linkedin');
          twin.gate('linkedin');
          twin.record('linkedin', 'posts.mentions', 'agent', { profileId });
          return clone(twin.linkedin.posts);
        },
        async getProfile(profileId) {
          if (twin.opts.linkedinUnavailable || !twin.linkedin) throw new AppUnavailableError('linkedin');
          twin.gate('linkedin');
          twin.record('linkedin', 'profile.get', 'agent', { profileId });
          return { followers: twin.linkedin.followers };
        },
      },
    };
  }

  private createDriveEntry(parentId: string, name: string, mimeType: string, content: Uint8Array, appProperties: Record<string, string>): DriveFile {
    const id = this.nextId('drv');
    const now = this.opts.now().toISOString();
    const meta: DriveFile = {
      id,
      name,
      mimeType,
      parents: [parentId],
      size: content.byteLength,
      sha256: mimeType === FOLDER_MIME ? null : sha256(content),
      createdTime: now,
      modifiedTime: now,
      appProperties,
    };
    this.drive.set(id, { meta, content, permissions: [{ id: this.nextId('perm'), role: 'owner', type: 'user', emailAddress: this.seed.owner }] });
    this.record('drive', mimeType === FOLDER_MIME ? 'folders.create' : 'files.create', 'agent', { fileId: id, path: this.drivePath(id), sha256: meta.sha256 });
    return clone(meta);
  }
}

export function buildEml(from: string, to: string[], date: string, subject: string, body: string, headers: Record<string, string>): string {
  const extra = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\r\n');
  return [`From: ${from}`, `To: ${to.join(', ')}`, `Date: ${date}`, `Subject: ${subject}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', extra, '', body]
    .filter((l, i) => !(l === '' && i === 6))
    .join('\r\n');
}
