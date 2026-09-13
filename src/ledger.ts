import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ExhibitRecord, FigureKind, FigureLabel, FigureStatus, Mapping, O1Criterion, SourceRef } from './types.js';

// One ledger joins everything (PRD 12.6): every row carries the run id, scenario id,
// trace id and release SHA, so every claim in the brief traces to a row.

export interface RunRow {
  run_id: string;
  scenario_id: string | null;
  attempt: number | null;
  release: string;
  trace_id: string | null;
  started_at: string;
  finished_at: string | null;
  mode: 'harness' | 'watch' | 'demo';
  outcome: string | null;
}

export interface CandidateRow {
  key: string;
  status: Mapping['status'];
  eb1a_status: Mapping['status'];
  criteria: O1Criterion[];
  mapping: Mapping;
  title: string;
  issuer: string | null;
  event_date: string | null;
  url: string | null;
  sources: SourceRef[];
  checks: { name: string; pass: boolean; detail: string }[];
  exhibit_id: string | null;
  updated_run: string;
}

export interface FigureSource {
  /** `api` when the figure came from a verifier API response (6.14); absent on older rows means web. */
  source_class?: 'api' | 'web';
  kind: FigureKind;
  url: string;
  publisher: string;
  sentence: string;
  snapshot_html_id: string | null;
  snapshot_pdf_id: string | null;
  snapshot_sha256: string;
  as_of: string;
}

export interface FigureRow {
  fig_id: string;
  exhibit_id: string;
  criterion: O1Criterion;
  measure: string;
  value: number;
  unit: string;
  as_of: string;
  sources: FigureSource[];
  label: FigureLabel | null;
  note: string;
  status: FigureStatus;
  fingerprint: string;
  detail: string | null;
  queued_at: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  run_id: string;
  trace_id: string | null;
}

export interface LetterRow {
  letter_id: string;
  recommender_email: string;
  recommender_name: string;
  relationship: 'dependent' | 'independent';
  exhibit_ids: string[];
  doc_id: string | null;
  state: 'drafted' | 'held' | 'approval_requested' | 'sent' | 'pending_approval';
  ws_decision: 'send' | 'revise' | 'hold' | null;
  ws_score: number | null;
  ws_reasons: string[];
  approval_msg_id: string | null;
  sent_msg_id: string | null;
  updated_run: string;
  trace_id: string | null;
}

export interface EventRow {
  run_id: string;
  trace_id: string | null;
  kind: string;
  detail: Record<string, unknown>;
  at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY, scenario_id TEXT, attempt INTEGER, release TEXT NOT NULL, trace_id TEXT,
  started_at TEXT NOT NULL, finished_at TEXT, mode TEXT NOT NULL, outcome TEXT
);
CREATE TABLE IF NOT EXISTS items (
  app TEXT NOT NULL, source_id TEXT NOT NULL, first_run TEXT NOT NULL, stage TEXT NOT NULL,
  classification TEXT, mapping TEXT, candidate_key TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app, source_id)
);
CREATE TABLE IF NOT EXISTS candidates (
  key TEXT PRIMARY KEY, status TEXT NOT NULL, eb1a_status TEXT NOT NULL, criteria TEXT NOT NULL, mapping TEXT NOT NULL,
  title TEXT NOT NULL, issuer TEXT, event_date TEXT, url TEXT, sources TEXT NOT NULL, checks TEXT NOT NULL,
  exhibit_id TEXT, updated_run TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS exhibits (
  exhibit_id TEXT PRIMARY KEY, key TEXT NOT NULL, version INTEGER NOT NULL, record TEXT NOT NULL,
  superseded_by TEXT, run_id TEXT NOT NULL, trace_id TEXT
);
CREATE INDEX IF NOT EXISTS exhibits_key ON exhibits(key);
CREATE TABLE IF NOT EXISTS figures (
  fig_id TEXT PRIMARY KEY, exhibit_id TEXT NOT NULL, criterion INTEGER NOT NULL, measure TEXT NOT NULL, value REAL NOT NULL,
  unit TEXT NOT NULL, as_of TEXT NOT NULL, sources TEXT NOT NULL, label TEXT, note TEXT NOT NULL, status TEXT NOT NULL,
  fingerprint TEXT NOT NULL, detail TEXT, queued_at TEXT, decided_at TEXT, decision_reason TEXT, run_id TEXT NOT NULL, trace_id TEXT
);
CREATE INDEX IF NOT EXISTS figures_fingerprint ON figures(fingerprint);
CREATE TABLE IF NOT EXISTS denied (fingerprint TEXT PRIMARY KEY, fig_id TEXT NOT NULL, reason TEXT, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outlet_cache (cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL, fetched_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS letters (
  letter_id TEXT PRIMARY KEY, recommender_email TEXT NOT NULL, recommender_name TEXT NOT NULL, relationship TEXT NOT NULL,
  exhibit_ids TEXT NOT NULL, doc_id TEXT, state TEXT NOT NULL, ws_decision TEXT, ws_score REAL, ws_reasons TEXT NOT NULL,
  approval_msg_id TEXT, sent_msg_id TEXT, updated_run TEXT NOT NULL, trace_id TEXT
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, trace_id TEXT, kind TEXT NOT NULL, detail TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS eval_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT NOT NULL, scenario_id TEXT NOT NULL, attempt INTEGER NOT NULL, run_ids TEXT NOT NULL,
  passed INTEGER NOT NULL, checks TEXT NOT NULL, side_effects TEXT NOT NULL, stub_hits TEXT NOT NULL, release TEXT NOT NULL, backend TEXT NOT NULL, at TEXT NOT NULL
);
`;

type Row = Record<string, unknown>;
const j = (v: unknown) => JSON.stringify(v);
const p = <T>(v: unknown): T => JSON.parse(String(v)) as T;

export class Ledger {
  readonly db: DatabaseSync;

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // runs
  startRun(row: Omit<RunRow, 'finished_at' | 'outcome'>): void {
    this.db
      .prepare('INSERT INTO runs (run_id, scenario_id, attempt, release, trace_id, started_at, mode) VALUES (?,?,?,?,?,?,?)')
      .run(row.run_id, row.scenario_id, row.attempt, row.release, row.trace_id, row.started_at, row.mode);
  }
  finishRun(runId: string, traceId: string | null, outcome: string, at: string): void {
    this.db.prepare('UPDATE runs SET finished_at = ?, outcome = ?, trace_id = COALESCE(?, trace_id) WHERE run_id = ?').run(at, outcome, traceId, runId);
  }
  runs(): RunRow[] {
    return this.db.prepare('SELECT * FROM runs ORDER BY started_at').all() as unknown as RunRow[];
  }

  // items
  itemSeen(app: string, id: string): { stage: string; attempts: number } | null {
    const r = this.db.prepare('SELECT stage, attempts FROM items WHERE app = ? AND source_id = ?').get(app, id) as Row | undefined;
    return r ? { stage: String(r.stage), attempts: Number(r.attempts) } : null;
  }
  markItem(app: string, id: string, runId: string, stage: string, data: { classification?: unknown; mapping?: unknown; candidateKey?: string | null } = {}): void {
    this.db
      .prepare(
        `INSERT INTO items (app, source_id, first_run, stage, classification, mapping, candidate_key, attempts) VALUES (?,?,?,?,?,?,?,1)
         ON CONFLICT(app, source_id) DO UPDATE SET stage = excluded.stage,
           classification = COALESCE(excluded.classification, items.classification),
           mapping = COALESCE(excluded.mapping, items.mapping),
           candidate_key = COALESCE(excluded.candidate_key, items.candidate_key),
           attempts = items.attempts + 1`,
      )
      .run(app, id, runId, stage, data.classification ? j(data.classification) : null, data.mapping ? j(data.mapping) : null, data.candidateKey ?? null);
  }
  itemsByStage(stage: string): { app: string; source_id: string }[] {
    return this.db.prepare('SELECT app, source_id FROM items WHERE stage = ?').all(stage) as unknown as { app: string; source_id: string }[];
  }

  // candidates
  upsertCandidate(c: CandidateRow): void {
    this.db
      .prepare(
        `INSERT INTO candidates (key, status, eb1a_status, criteria, mapping, title, issuer, event_date, url, sources, checks, exhibit_id, updated_run)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(key) DO UPDATE SET status = excluded.status, eb1a_status = excluded.eb1a_status, criteria = excluded.criteria,
           mapping = excluded.mapping, title = excluded.title, issuer = excluded.issuer, event_date = excluded.event_date, url = excluded.url,
           sources = excluded.sources, checks = excluded.checks, exhibit_id = COALESCE(excluded.exhibit_id, candidates.exhibit_id), updated_run = excluded.updated_run`,
      )
      .run(c.key, c.status, c.eb1a_status, j(c.criteria), j(c.mapping), c.title, c.issuer, c.event_date, c.url, j(c.sources), j(c.checks), c.exhibit_id, c.updated_run);
  }
  candidate(key: string): CandidateRow | null {
    const r = this.db.prepare('SELECT * FROM candidates WHERE key = ?').get(key) as Row | undefined;
    return r ? this.toCandidate(r) : null;
  }
  candidates(): CandidateRow[] {
    return (this.db.prepare('SELECT * FROM candidates ORDER BY key').all() as Row[]).map((r) => this.toCandidate(r));
  }
  private toCandidate(r: Row): CandidateRow {
    return {
      key: String(r.key),
      status: r.status as Mapping['status'],
      eb1a_status: r.eb1a_status as Mapping['status'],
      criteria: p(r.criteria),
      mapping: p(r.mapping),
      title: String(r.title),
      issuer: (r.issuer as string) ?? null,
      event_date: (r.event_date as string) ?? null,
      url: (r.url as string) ?? null,
      sources: p(r.sources),
      checks: p(r.checks),
      exhibit_id: (r.exhibit_id as string) ?? null,
      updated_run: String(r.updated_run),
    };
  }

  // exhibits (append-only; corrections are new versions)
  nextExhibitId(criterion: number | string): string {
    const prefix = `EX-${criterion}-`;
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM exhibits WHERE exhibit_id LIKE ?').get(`${prefix}%`) as Row;
    return `${prefix}${String(Number(r.n) + 1).padStart(3, '0')}`;
  }
  insertExhibit(rec: ExhibitRecord, runId: string, traceId: string | null): void {
    this.db.prepare('INSERT INTO exhibits (exhibit_id, key, version, record, run_id, trace_id) VALUES (?,?,?,?,?,?)').run(rec.exhibit_id, rec.key, rec.version, j(rec), runId, traceId);
  }
  supersede(oldId: string, newId: string): void {
    this.db.prepare('UPDATE exhibits SET superseded_by = ? WHERE exhibit_id = ?').run(newId, oldId);
  }
  exhibitByKey(key: string): ExhibitRecord | null {
    const r = this.db.prepare('SELECT record FROM exhibits WHERE key = ? AND superseded_by IS NULL ORDER BY version DESC LIMIT 1').get(key) as Row | undefined;
    return r ? p<ExhibitRecord>(r.record) : null;
  }
  exhibit(id: string): ExhibitRecord | null {
    const r = this.db.prepare('SELECT record FROM exhibits WHERE exhibit_id = ?').get(id) as Row | undefined;
    return r ? p<ExhibitRecord>(r.record) : null;
  }
  exhibits(includeSuperseded = false): ExhibitRecord[] {
    const sql = includeSuperseded ? 'SELECT record FROM exhibits ORDER BY exhibit_id' : 'SELECT record FROM exhibits WHERE superseded_by IS NULL ORDER BY exhibit_id';
    return (this.db.prepare(sql).all() as Row[]).map((r) => p<ExhibitRecord>(r.record));
  }

  // figures
  insertFigure(f: FigureRow): void {
    this.db
      .prepare(
        `INSERT INTO figures (fig_id, exhibit_id, criterion, measure, value, unit, as_of, sources, label, note, status, fingerprint, detail, queued_at, decided_at, decision_reason, run_id, trace_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(f.fig_id, f.exhibit_id, f.criterion, f.measure, f.value, f.unit, f.as_of, j(f.sources), f.label, f.note, f.status, f.fingerprint, f.detail, f.queued_at, f.decided_at, f.decision_reason, f.run_id, f.trace_id);
  }
  updateFigure(figId: string, patch: Partial<Pick<FigureRow, 'status' | 'decided_at' | 'decision_reason' | 'sources' | 'detail'>>): void {
    const cur = this.figure(figId);
    if (!cur) throw new Error(`unknown figure ${figId}`);
    const next = { ...cur, ...patch };
    this.db
      .prepare('UPDATE figures SET status = ?, decided_at = ?, decision_reason = ?, sources = ?, detail = ? WHERE fig_id = ?')
      .run(next.status, next.decided_at, next.decision_reason, j(next.sources), next.detail, figId);
  }
  figure(figId: string): FigureRow | null {
    const r = this.db.prepare('SELECT * FROM figures WHERE fig_id = ?').get(figId) as Row | undefined;
    return r ? this.toFigure(r) : null;
  }
  figures(filter: { status?: FigureStatus; exhibitId?: string } = {}): FigureRow[] {
    const rows = this.db.prepare('SELECT * FROM figures ORDER BY fig_id').all() as Row[];
    return rows
      .map((r) => this.toFigure(r))
      .filter((f) => (!filter.status || f.status === filter.status) && (!filter.exhibitId || f.exhibit_id === filter.exhibitId));
  }
  figureByFingerprint(fp: string): FigureRow | null {
    const r = this.db.prepare('SELECT * FROM figures WHERE fingerprint = ? ORDER BY fig_id DESC LIMIT 1').get(fp) as Row | undefined;
    return r ? this.toFigure(r) : null;
  }
  nextFigureId(): string {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM figures').get() as Row;
    return `FIG-${String(Number(r.n) + 1).padStart(3, '0')}`;
  }
  private toFigure(r: Row): FigureRow {
    return {
      fig_id: String(r.fig_id),
      exhibit_id: String(r.exhibit_id),
      criterion: Number(r.criterion) as O1Criterion,
      measure: String(r.measure),
      value: Number(r.value),
      unit: String(r.unit),
      as_of: String(r.as_of),
      sources: p(r.sources),
      label: (r.label as FigureLabel) ?? null,
      note: String(r.note),
      status: r.status as FigureStatus,
      fingerprint: String(r.fingerprint),
      detail: (r.detail as string) ?? null,
      queued_at: (r.queued_at as string) ?? null,
      decided_at: (r.decided_at as string) ?? null,
      decision_reason: (r.decision_reason as string) ?? null,
      run_id: String(r.run_id),
      trace_id: (r.trace_id as string) ?? null,
    };
  }
  deny(fingerprint: string, figId: string, reason: string | null, at: string): void {
    this.db.prepare('INSERT OR IGNORE INTO denied (fingerprint, fig_id, reason, at) VALUES (?,?,?,?)').run(fingerprint, figId, reason, at);
  }
  isDenied(fingerprint: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM denied WHERE fingerprint = ?').get(fingerprint);
  }

  // outlet cache (6.11)
  cacheGet<T>(key: string): { payload: T; fetched_at: string } | null {
    const r = this.db.prepare('SELECT payload, fetched_at FROM outlet_cache WHERE cache_key = ?').get(key) as Row | undefined;
    return r ? { payload: p<T>(r.payload), fetched_at: String(r.fetched_at) } : null;
  }
  cacheSet(key: string, payload: unknown, at: string): void {
    this.db.prepare('INSERT INTO outlet_cache (cache_key, payload, fetched_at) VALUES (?,?,?) ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at').run(key, j(payload), at);
  }

  // letters
  letter(id: string): LetterRow | null {
    const r = this.db.prepare('SELECT * FROM letters WHERE letter_id = ?').get(id) as Row | undefined;
    return r ? this.toLetter(r) : null;
  }
  letters(): LetterRow[] {
    return (this.db.prepare('SELECT * FROM letters ORDER BY letter_id').all() as Row[]).map((r) => this.toLetter(r));
  }
  upsertLetter(l: LetterRow): void {
    this.db
      .prepare(
        `INSERT INTO letters (letter_id, recommender_email, recommender_name, relationship, exhibit_ids, doc_id, state, ws_decision, ws_score, ws_reasons, approval_msg_id, sent_msg_id, updated_run, trace_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(letter_id) DO UPDATE SET exhibit_ids = excluded.exhibit_ids, doc_id = excluded.doc_id, state = excluded.state,
           ws_decision = excluded.ws_decision, ws_score = excluded.ws_score, ws_reasons = excluded.ws_reasons,
           approval_msg_id = excluded.approval_msg_id, sent_msg_id = excluded.sent_msg_id, updated_run = excluded.updated_run, trace_id = excluded.trace_id`,
      )
      .run(l.letter_id, l.recommender_email, l.recommender_name, l.relationship, j(l.exhibit_ids), l.doc_id, l.state, l.ws_decision, l.ws_score, j(l.ws_reasons), l.approval_msg_id, l.sent_msg_id, l.updated_run, l.trace_id);
  }
  private toLetter(r: Row): LetterRow {
    return {
      letter_id: String(r.letter_id),
      recommender_email: String(r.recommender_email),
      recommender_name: String(r.recommender_name),
      relationship: r.relationship as LetterRow['relationship'],
      exhibit_ids: p(r.exhibit_ids),
      doc_id: (r.doc_id as string) ?? null,
      state: r.state as LetterRow['state'],
      ws_decision: (r.ws_decision as LetterRow['ws_decision']) ?? null,
      ws_score: r.ws_score === null ? null : Number(r.ws_score),
      ws_reasons: p(r.ws_reasons),
      approval_msg_id: (r.approval_msg_id as string) ?? null,
      sent_msg_id: (r.sent_msg_id as string) ?? null,
      updated_run: String(r.updated_run),
      trace_id: (r.trace_id as string) ?? null,
    };
  }

  // key-value (binder ids, scorecard doc id, review sheet id, cursors)
  get(k: string): string | null {
    const r = this.db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as Row | undefined;
    return r ? String(r.v) : null;
  }
  set(k: string, v: string): void {
    this.db.prepare('INSERT INTO kv (k, v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
  }

  // events
  event(e: EventRow): void {
    this.db.prepare('INSERT INTO events (run_id, trace_id, kind, detail, at) VALUES (?,?,?,?,?)').run(e.run_id, e.trace_id, e.kind, j(e.detail), e.at);
  }
  events(filter: { kind?: string; runId?: string } = {}): (EventRow & { id: number })[] {
    return (this.db.prepare('SELECT * FROM events ORDER BY id').all() as Row[])
      .map((r) => ({ id: Number(r.id), run_id: String(r.run_id), trace_id: (r.trace_id as string) ?? null, kind: String(r.kind), detail: p<Record<string, unknown>>(r.detail), at: String(r.at) }))
      .filter((e) => (!filter.kind || e.kind === filter.kind) && (!filter.runId || e.run_id === filter.runId));
  }

  // eval results
  recordEval(r: { batch_id: string; scenario_id: string; attempt: number; run_ids: string[]; passed: boolean; checks: unknown; side_effects: unknown; stub_hits: unknown; release: string; backend: string; at: string }): void {
    this.db
      .prepare('INSERT INTO eval_results (batch_id, scenario_id, attempt, run_ids, passed, checks, side_effects, stub_hits, release, backend, at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(r.batch_id, r.scenario_id, r.attempt, j(r.run_ids), r.passed ? 1 : 0, j(r.checks), j(r.side_effects), j(r.stub_hits), r.release, r.backend, r.at);
  }

  exportJson(): Record<string, unknown> {
    return {
      exhibits: this.exhibits(true),
      candidates: this.candidates(),
      figures: this.figures(),
      letters: this.letters(),
      runs: this.runs(),
    };
  }
}
