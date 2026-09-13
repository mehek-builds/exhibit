import type { RunSummary } from '../src/agent.js';
import type { DriveApi, DriveFile } from '../src/apps/types.js';
import { FOLDER_MIME } from '../src/apps/types.js';
import { FixtureTransport } from '../src/integrations/types.js';
import { createIntegrityExtension } from '../src/integrity/extension.js';
import { verifyBinder } from '../src/integrity/verify.js';
import { letterId } from '../src/letters/letters.js';
import { createSigningExtension } from '../src/letters/signing.js';
import type { AuditIssue } from '../src/observability/audit.js';
import type { RuleOptions } from '../src/rules/explicit.js';
import { MemoryDropboxSign } from '../src/twins/fakes.js';
import type { FounderProfile } from '../src/types.js';
import type { ArgaTwinsAdapter } from './arga-backend.js';
import { createArgaHarnessEnv } from './arga-backend.js';
import { DARA, mail, seed } from './corpus.js';
import type { HarnessEnv, TwinsHandle } from './env.js';
import { createHarnessEnv, defaultModel } from './env.js';
import { createIntegrityFixtures } from './fixtures/integrity.js';
import { prohibitedSideEffects } from './grade.js';
import type { KnownAnswers } from './metrics.js';
import { knownAnswers } from './metrics.js';
import type { GradeCheck, Scenario } from './scenarios.js';
import { scenarios as loadScenarios } from './scenarios.js';

// Ledger event kinds the brief (owned by src/brief.ts) reads back per attempt. Additive to this
// file only (file-ownership rules): AttemptResult/MatrixResult grow an optional `metrics` field;
// selection, pass/fail and grading logic below are unchanged.
const METRICS_EVENT_KINDS = [
  'text_in',
  'text_out',
  'notification',
  'integration_call',
  'discovery',
  'timestamp',
  'archive',
  'verify',
  'signature',
  'translation',
  'extension_error',
  'audit_issue',
  'letter_held',
  'letter_sent',
  'approval_requested',
  'digest_sent',
  'figure_hallucination',
  'source_blocked',
] as const;
const MAX_EVENTS_PER_KIND = 25;

export interface AttemptMetrics {
  eventCounts: Record<string, number>;
  events: { kind: string; detail: Record<string, unknown>; at: string }[];
  groundTruth?: KnownAnswers;
  stubHits: string[];
  backend: 'memory' | 'arga';
}

// The Arga matrix runner (PRD 12.3, 12.6): 3 attempts per scenario by default, each on a fresh
// harness environment, graded from twin and ledger end state. This is the contract the CLI codes
// against, so its shapes must stay JSON-serializable and stable.

export interface AttemptResult {
  scenarioId: string;
  title: string;
  core: boolean;
  attempt: number;
  passed: boolean;
  checks: GradeCheck[];
  sideEffects: { kind: string; detail: string }[];
  stubHits: string[];
  runs: RunSummary[];
  issues: AuditIssue[];
  durationMs: number;
  error?: string;
  metrics?: AttemptMetrics;
}

export interface ScenarioStats {
  scenarioId: string;
  title: string;
  core: boolean;
  attempts: number;
  passed: number;
  sideEffects: number;
}

export interface MatrixResult {
  batchId: string;
  release: string;
  backend: 'memory' | 'arga';
  model: string;
  gateTransport: string;
  startedAt: string;
  finishedAt: string;
  attempts: AttemptResult[];
  stats: ScenarioStats[];
  allCorePassed: boolean;
}

export interface MatrixOptions {
  scenarios?: string[];
  core?: boolean;
  attempts?: number;
  gate?: 'mcp' | 'library';
  ruleOptions?: RuleOptions;
  release?: string;
  /** Selects the twin backend; defaults to 'memory'. 'arga' requires argaApiKey. */
  backend?: 'memory' | 'arga';
  /** Required when backend === 'arga'. */
  argaApiKey?: string;
  /** Test-only: overrides the Arga API host (createArgaHarnessEnv's `baseUrl`), matching
   * ARGA_BASE_URL (docs/ARGA.md). Lets test/arga-runner.test.ts point 'arga' at a fake control
   * plane instead of the real service. */
  argaBaseUrl?: string;
  /** Test-only: overrides which twins createArgaHarnessEnv provisions (defaults to
   * harness/arga-backend.ts's ARGA_TWIN_NAMES). Lets a test request a smaller twin set. */
  argaTwins?: string[];
  onAttempt?: (r: AttemptResult) => void;
}

export function listScenarios(): Scenario[] {
  return loadScenarios();
}

/** Wraps ArgaTwinsAdapter so it structurally matches TwinsHandle and an Arga-backed env can be
 * passed anywhere a HarnessEnv is expected (s.play/s.grade/prohibitedSideEffects/knownAnswers, and
 * harness/presets.ts's `env.twins.recordOp(...)` calls for the Twilio/DropboxSign/DeepL fakes). */
function wrapArgaTwins(adapter: ArgaTwinsAdapter): TwinsHandle {
  return {
    get backend() {
      return adapter.backend;
    },
    get ops() {
      return adapter.ops;
    },
    get stubHits() {
      return adapter.stubHits;
    },
    state: () => adapter.state(),
    drivePath: (fileId) => adapter.drivePath(fileId),
    driveContent: (fileId) => adapter.driveContent(fileId),
    recordOp: (app, op, actor, detail) => adapter.recordOp(app, op, actor, detail),
    settle: async () => {
      await adapter.settle();
      await adapter.refresh();
      // The grade reads this refresh; a twin that could not be read here must fail the attempt,
      // never grade an empty state as clean (the per-run guard only covers env.run()).
      if (adapter.evidenceUnavailable) throw new Error(`arga_side_effect_evidence_unavailable: ${adapter.evidenceGaps.join(', ')}`);
      if (adapter.degraded.size > 0) throw new Error(`arga_twin_degraded: ${[...adapter.degraded].join(', ')}`);
    },
    adminAddMessage: (msg) => adapter.adminAddMessage(msg),
    adminShareFile: (fileId, email) => adapter.adminShareFile(fileId, email),
    adminOverwriteFile: (fileId, content) => adapter.adminOverwriteFile(fileId, content),
    adminSetSheetCell: (spreadsheetId, match, column, value) => adapter.adminSetSheetCell(spreadsheetId, match, column, value),
  };
}

/** One Arga scenario (client.scenarios.create) per Exhibit scenario, reused across attempts and
 * reseeded between them (PRD 7.1's "one Twin Run ID" per scenario, updated for arga-backend.ts's
 * scenario-based seeding path -- see that file's header). Keyed off the module so it survives across
 * the sequential attempt loop in runMatrix but never leaks between unrelated scenario ids. */
const argaScenarioIdByScenario = new Map<string, string>();

async function buildEnv(s: Scenario, attempt: number, opts: MatrixOptions): Promise<HarnessEnv> {
  if (opts.backend === 'arga') {
    if (!opts.argaApiKey) throw new Error("backend 'arga' requires argaApiKey (set ARGA_API_KEY)");
    const argaEnv = await createArgaHarnessEnv({
      apiKey: opts.argaApiKey,
      seed: s.seed(),
      profile: s.profile ?? DARA,
      gate: opts.gate ?? s.gate ?? 'mcp',
      scenarioId: s.id,
      attempt,
      ruleOptions: opts.ruleOptions,
      release: opts.release ?? 'dev',
      // Only reuse a cached Arga scenario from attempt 2 on -- attempt 1 always creates fresh, so a
      // stale id left over from an earlier, unrelated run of this scenario id (e.g. a prior batch
      // against a different Arga host) is never resumed by accident.
      reuseArgaScenarioId: attempt > 1 ? argaScenarioIdByScenario.get(s.id) : undefined,
      baseUrl: opts.argaBaseUrl,
      twins: opts.argaTwins,
      extensions: s.features,
      twinOptions: s.twinOptions,
      now: s.env?.now,
    });
    argaScenarioIdByScenario.set(s.id, argaEnv.argaScenarioId);
    // The same 6.13/6.14 wiring createHarnessEnv applies, built against the wrapped env so the
    // fakes (Twilio, Dropbox Sign, verifier APIs) reach its twins.
    const env: HarnessEnv = { ...argaEnv, twins: wrapArgaTwins(argaEnv.twins) };
    if (s.env?.twilio) env.deps.apps.twilio = s.env.twilio(env);
    if (s.env?.extensions) env.deps.extensions = s.env.extensions(env);
    if (s.env?.structured) env.deps.structured = s.env.structured;
    return env;
  }
  return createHarnessEnv({
    seed: s.seed(),
    profile: s.profile,
    gate: opts.gate ?? s.gate ?? 'mcp',
    twinOptions: s.twinOptions,
    features: s.features,
    scenarioId: s.id,
    attempt,
    release: opts.release ?? 'dev',
    ruleOptions: opts.ruleOptions,
    // Scenario-specific wiring for the 6.13/6.14 features: extensions, the Twilio fake, verifier APIs, clock.
    ...s.env,
  });
}

export async function runScenarioAttempt(s: Scenario, attempt: number, opts: MatrixOptions = {}): Promise<AttemptResult> {
  const started = Date.now();
  const backend = opts.backend ?? 'memory';

  let checks: GradeCheck[] = [];
  let sideEffects: { kind: string; detail: string }[] = [];
  let stubHits: string[] = [];
  let issues: AuditIssue[] = [];
  let error: string | undefined;
  let metrics: AttemptMetrics | undefined;
  let env: HarnessEnv | undefined;

  try {
    env = await buildEnv(s, attempt, opts);
    await s.play({ env });
    await env.twins.settle?.();
    checks = await s.grade({ env });
    sideEffects = prohibitedSideEffects(env);
    stubHits = env.twins.state().stubHits;
    issues = env.runs.flatMap((r) => r.issues);

    const eventCounts: Record<string, number> = {};
    const events: AttemptMetrics['events'] = [];
    for (const kind of METRICS_EVENT_KINDS) {
      const rows = env.ledger.events({ kind });
      eventCounts[kind] = rows.length;
      for (const r of rows.slice(0, MAX_EVENTS_PER_KIND)) events.push({ kind: r.kind, detail: r.detail, at: r.at });
    }
    metrics = {
      eventCounts,
      events,
      groundTruth: s.id === 'S1' ? knownAnswers(env) : undefined,
      stubHits,
      backend,
    };
  } catch (err) {
    error = err instanceof Error ? (err.stack ?? err.message) : String(err);
  } finally {
    await env?.close();
  }

  const degraded = env?.runs.some((r) => r.outcome === 'degraded') ?? false;
  const passed = !error && checks.length > 0 && checks.every((c) => c.pass) && sideEffects.length === 0 && !degraded;

  return {
    scenarioId: s.id,
    title: s.title,
    core: s.core,
    attempt,
    passed,
    checks,
    sideEffects,
    stubHits,
    runs: env?.runs ?? [],
    issues,
    durationMs: Date.now() - started,
    error,
    metrics,
  };
}

export async function runMatrix(opts: MatrixOptions = {}): Promise<MatrixResult> {
  const startedAt = new Date().toISOString();
  const all = loadScenarios();
  // `core: true` narrows to core scenarios; anything else runs every selected scenario.
  const selected = all.filter((s) => (!opts.scenarios || opts.scenarios.includes(s.id)) && (!opts.core || s.core));
  const attempts: AttemptResult[] = [];
  const attemptCount = opts.attempts ?? 3;

  for (const s of selected) {
    for (let a = 1; a <= attemptCount; a++) {
      const r = await runScenarioAttempt(s, a, opts);
      attempts.push(r);
      opts.onAttempt?.(r);
    }
  }

  const statsMap = new Map<string, ScenarioStats>();
  for (const s of selected) statsMap.set(s.id, { scenarioId: s.id, title: s.title, core: s.core, attempts: 0, passed: 0, sideEffects: 0 });
  for (const r of attempts) {
    const st = statsMap.get(r.scenarioId);
    if (!st) continue;
    st.attempts += 1;
    if (r.passed) st.passed += 1;
    st.sideEffects += r.sideEffects.length;
  }
  const stats = [...statsMap.values()];
  // Never vacuously true: a batch with no core scenario did not prove the core passes.
  const coreStats = stats.filter((s) => s.core);
  const allCorePassed = coreStats.length > 0 && coreStats.every((s) => s.attempts > 0 && s.passed === s.attempts && s.sideEffects === 0);

  return {
    batchId: `batch_${Date.now()}`,
    release: opts.release ?? 'dev',
    backend: opts.backend ?? 'memory',
    model: defaultModel().modelId,
    gateTransport: opts.gate ?? 'mcp',
    startedAt,
    finishedAt: new Date().toISOString(),
    attempts,
    stats,
    allCorePassed,
  };
}

/** Recursive drive walk used only by the S22 integrity mutation below (mirrors src/integrity/verify.ts's private walkFiles). */
async function walkDriveFiles(drive: DriveApi, rootId: string): Promise<DriveFile[]> {
  const out: DriveFile[] = [];
  const queue = [rootId];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const child of await drive.listChildren(parent)) {
      if (child.mimeType === FOLDER_MIME) queue.push(child.id);
      else out.push(child);
    }
  }
  return out;
}

/**
 * X-integrity-tamper-check mutation (PRD 12.2, S22): `verifyBinder` is called directly by S22's own
 * `grade`, with no `ruleOptions` threading (that call site is out of scope for this change), so this
 * runs `verifyBinder` here instead, with `ruleOptions` reaching it. It corrupts the *ledger's
 * recorded hash* for an already-stamped file rather than the file's bytes: `verifyProof` (owned by
 * another agent, src/integrity/opentimestamps.ts) independently recomputes the digest from the file
 * bytes and compares it to the digest embedded in the .ots proof itself, so a bytes-level tamper is
 * always caught by that second, unrelated mechanism regardless of this guard -- it does not isolate
 * whether verify.ts's own hash comparison is load-bearing. A kv-only drift (bytes untouched, proof
 * still valid, but the ledger's cached hash no longer matches) is caught *only* by verify.ts's own
 * comparison, so it is the guard this rule actually switches off. A live run never disables this:
 * `disabled` is only ever set by this function and by the mutation matrix.
 */
async function runIntegrityTamperMutation(disabled: string[]): Promise<{ caught: boolean; detail: string }> {
  const s22 = loadScenarios().find((s) => s.id === 'S22');
  if (!s22) return { caught: false, detail: 'S22 not found' };

  const fixtures = createIntegrityFixtures();
  const transport = new FixtureTransport(fixtures.fixtures);
  const env = createHarnessEnv({
    seed: s22.seed(),
    profile: s22.profile,
    gate: s22.gate ?? 'mcp',
    twinOptions: s22.twinOptions,
    features: s22.features,
    scenarioId: s22.id,
    attempt: 1,
    release: 'dev',
    ruleOptions: { disabled },
    ...s22.env,
  });
  try {
    env.deps.extensions = [...(env.deps.extensions ?? []), createIntegrityExtension({ transport, blockHeaders: fixtures.blockHeaders })];
    await env.run(); // stamps every filed artifact

    const binder = JSON.parse(env.ledger.get('binder')!) as { root: string };
    const files = await walkDriveFiles(env.deps.apps.drive, binder.root);
    const original = files.find((f) => f.appProperties?.role === 'original' && env.ledger.get(`ots:${f.id}`));
    if (!original) return { caught: false, detail: 'no stamped original artifact to corrupt' };

    // Corrupt only the ledger's cached hash for this file -- the file bytes and its .ots proof are
    // both untouched, so verifyProof alone would report this file clean.
    const kvKey = `ots:${original.id}`;
    const record = JSON.parse(env.ledger.get(kvKey)!) as { sha256: string; ots_file_id: string; status: string };
    env.ledger.set(kvKey, JSON.stringify({ ...record, sha256: '0'.repeat(64) }));

    const result = await verifyBinder({ drive: env.deps.apps.drive, ledger: env.ledger, binderRoot: binder.root, blockHeaders: fixtures.blockHeaders, ruleOptions: env.deps.ruleOptions });
    const caught = result.failed.some((f) => f.path === original.name);
    return { caught, detail: `failed=${JSON.stringify(result.failed)}, passed=${result.passed.length}` };
  } finally {
    await env.close();
  }
}

/**
 * X-sign-both-approvals mutation (PRD 12.2, S23): S23's own three recommenders don't isolate this
 * rule cleanly -- the one who never confirms (Alex) also isn't a controlled signer address, so
 * constraint 18's separate day-mode gate already refuses his request either way, masking the
 * confirmation gate. This is a minimal, self-contained analog of S23 (same pattern: a judging
 * invite, the founder's reply, a thank-you email, then the letter pipeline) with one recommender
 * who *is* a controlled signer but never confirms the final text -- isolating the guard.
 */
const S23_MUTATION_RECOMMENDER = DARA.recommenderCandidates.find((r) => r.email === 'marco@hackmesa.example')!;

async function runSignBothApprovalsMutation(disabled: string[]): Promise<{ caught: boolean; detail: string }> {
  const r = S23_MUTATION_RECOMMENDER;
  const id = letterId(r);
  const profile: FounderProfile = { ...DARA, recommenderCandidates: [r], controlledEmails: [...(DARA.controlledEmails ?? []), r.email] };
  const gmail = [
    mail({ id: 'sm-invite', from: 'Marco Ellis <marco@hackmesa.example>', date: '2025-10-20T17:00:00Z', subject: 'Invitation to judge HackMesa 2026', body: 'Hi Dara,\n\nWe would like to invite you to serve as a judge at HackMesa 2026 on January 24, 2026.\n\nMarco Ellis\nLead Organizer, HackMesa' }),
    mail({ id: 'sm-reply', from: `Dara Voss <${DARA.emails[0]}>`, to: ['marco@hackmesa.example'], date: '2025-10-21T09:00:00Z', subject: 'Re: Invitation to judge HackMesa 2026', body: "I'd be glad to judge. Count me in!", labels: ['SENT'] }),
    mail({ id: 'sm-thanks', from: 'Marco Ellis <marco@hackmesa.example>', date: '2026-01-26T18:00:00Z', subject: 'Thank you for judging HackMesa 2026', body: 'Hi Dara,\n\nThank you for judging. You judged 62 submissions from 400 student hackers.\n\nMarco' }),
  ];

  const env = createHarnessEnv({ seed: seed({ gmail }), profile, gate: 'library' });
  try {
    const fake = new MemoryDropboxSign({ testMode: true, now: () => env.clock.now(), record: (a, o, ac, d) => env.twins.recordOp(a, o, ac, d) });
    env.deps.extensions = [createSigningExtension({ client: fake, dayMode: true })];
    env.deps.ruleOptions = { disabled };

    await env.run(); // drafts and sends the letter request
    const base = env.clock.now();
    env.twins.adminAddMessage({ from: `Dara Voss <${DARA.emails[0]}>`, to: [DARA.emails[0]!], date: new Date(base.getTime() + 60_000).toUTCString(), subject: `Re: [Exhibit] Approve letter request ${id}`, body: `APPROVE ${id}` });
    await env.run();
    await env.run(); // letter sent to the recommender

    // Marco never confirms the final text -- only the founder approves the signature request.
    const t = env.clock.now();
    env.twins.adminAddMessage({ from: `Dara Voss <${DARA.emails[0]}>`, to: [DARA.emails[0]!], date: new Date(t.getTime() + 30_000).toUTCString(), subject: `Re: [Exhibit] Approve signature request ${id}`, body: `APPROVE SIGN ${id}` });
    await env.run(); // with the guard intact, this must never create a request: no confirmation ever arrived
    await env.run();

    const state = JSON.parse(env.ledger.get(`sign:${id}`) ?? '{}') as { requestId?: string; stage?: string };
    const requests = fake.state().requests;
    const requestExists = !!state.requestId || requests.some((req) => req.signerEmail === r.email);
    // caught === true means the guard held (no request without both approvals) -- the mutation survived.
    return { caught: !requestExists, detail: `state=${JSON.stringify(state)}, requests=${JSON.stringify(requests.map((req) => req.signerEmail))}` };
  } finally {
    await env.close();
  }
}

/** Mutation check on the harness itself (PRD 12.2): disabling a working rule must turn its scenario red. */
export async function mutationCheck(opts: { attempts?: number } = {}): Promise<{ mutations: { name: string; disabled: string[]; scenario: string; killed: boolean; detail: string }[] }> {
  const attemptCount = opts.attempts ?? 1;
  const all = loadScenarios();
  const s2 = all.find((s) => s.id === 'S2');
  const s3 = all.find((s) => s.id === 'S3');
  const s20 = all.find((s) => s.id === 'S20');
  const s21 = all.find((s) => s.id === 'S21');
  const s23 = all.find((s) => s.id === 'S23');
  const s24 = all.find((s) => s.id === 'S24');
  const mutations: { name: string; disabled: string[]; scenario: string; killed: boolean; detail: string }[] = [];

  const run = async (name: string, scenario: Scenario | undefined, disabled: string[]) => {
    if (!scenario) {
      mutations.push({ name, disabled, scenario: 'unknown', killed: false, detail: 'scenario not found' });
      return;
    }
    let allFailed = true;
    const details: string[] = [];
    for (let a = 1; a <= attemptCount; a++) {
      const r = await runScenarioAttempt(scenario, a, { ruleOptions: { disabled } });
      if (r.passed) allFailed = false;
      details.push(r.error ?? r.checks.filter((c) => !c.pass).map((c) => `${c.name}: ${c.detail}`).join('; ') ?? '');
    }
    mutations.push({ name, disabled, scenario: scenario.id, killed: allFailed, detail: details.join(' | ') });
  };

  await run('disable D-accelerator-acceptance (S2 must go red)', s2, ['D-accelerator-acceptance']);
  await run('disable D-funding-remuneration + T-funding-not-award (S3 must go red)', s3, ['D-funding-remuneration', 'T-funding-not-award']);
  await run('disable X-second-identifier (S21 must go red)', s21, ['X-second-identifier']);
  await run('disable TX-verified-number (S20 must go red)', s20, ['TX-verified-number']);
  await run('disable TX-confirm-irreversible (S20 must go red)', s20, ['TX-confirm-irreversible']);
  await run('disable X-translation-opt-in (S24 must go red)', s24, ['X-translation-opt-in']);
  void s23; // S23's own three recommenders don't isolate X-sign-both-approvals cleanly; see the bespoke check below.

  {
    const disabled = ['X-integrity-tamper-check'];
    let allFailed = true;
    const details: string[] = [];
    for (let a = 1; a <= attemptCount; a++) {
      const r = await runIntegrityTamperMutation(disabled);
      if (r.caught) allFailed = false; // verify still caught the tamper despite the disabled flag -- the mutation survived
      details.push(r.detail);
    }
    mutations.push({ name: 'disable X-integrity-tamper-check (S22 verify must go red)', disabled, scenario: 'S22', killed: allFailed, detail: details.join(' | ') });
  }

  {
    const disabled = ['X-sign-both-approvals'];
    let allFailed = true;
    const details: string[] = [];
    for (let a = 1; a <= attemptCount; a++) {
      const r = await runSignBothApprovalsMutation(disabled);
      if (r.caught) allFailed = false; // the guard held even with the flag set -- the mutation survived
      details.push(r.detail);
    }
    mutations.push({ name: 'disable X-sign-both-approvals (signing must create a request after only one approval)', disabled, scenario: 'S23', killed: allFailed, detail: details.join(' | ') });
  }

  return { mutations };
}
