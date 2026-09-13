import { randomUUID } from 'node:crypto';
import type { Apps } from './apps/types.js';
import { TwinStubError } from './apps/types.js';
import type { BinderIds } from './binder/filer.js';
import { BINDER_ROOT, ensureBinder, fileVerified, writeBinderIndexes } from './binder/filer.js';
import type { Scorecard } from './binder/scorecard.js';
import { buildScorecard, renderScorecard, writeScorecard } from './binder/scorecard.js';
import type { StructuredResearch } from './integrations/types.js';
import type { Ledger } from './ledger.js';
import type { LetterSummary } from './letters/letters.js';
import { processLetters } from './letters/letters.js';
import type { WorthSendingGate } from './letters/worthSending.js';
import type { EvidenceModel } from './models/types.js';
import type { AuditIssue } from './observability/audit.js';
import { auditRun } from './observability/audit.js';
import type { TraceContext, Tracer } from './observability/tracer.js';
import type { IntakeContext } from './pipeline/intake.js';
import { intake } from './pipeline/intake.js';
import { classifyAndMap } from './pipeline/mapper.js';
import { redactItem } from './pipeline/redact.js';
import { DegradedRunError } from './pipeline/resilience.js';
import type { Candidate } from './pipeline/verifier.js';
import { verify } from './pipeline/verifier.js';
import type { CorroborateSummary, SourcePolicy } from './research/corroborator.js';
import { corroborate } from './research/corroborator.js';
import type { Researcher, WebFetcher } from './research/types.js';
import type { ReviewSummary } from './review/queue.js';
import { applyDecisions, queueFigures } from './review/queue.js';
import type { RuleOptions } from './rules/explicit.js';
import type { PromptGraph } from './rules/graph.js';
import type { Clock, ExhibitRecord, FounderProfile, SourceItem } from './types.js';
import { isoDay } from './util.js';

// One Exhibit run (PRD section 6): intake, discovery, redact, classify, map, verify, file, review
// decisions, corroborate, queue, letters, scorecard, audit. Harness mode calls this directly so grading
// never depends on polling timing; watch mode calls it on a schedule. The 6.13 and 6.14 features plug in
// as extensions at fixed points, so each one can fail on its own without taking the run down (PRD 10).

export interface ExtensionContext {
  deps: AgentDeps;
  trace: TraceContext;
  runId: string;
  now: Date;
  binder: BinderIds;
  context: IntakeContext;
  summary: RunSummary;
}

export interface AgentExtension {
  readonly name: string;
  /** Extra source items (discovery sources), classified like any email. */
  discover?(ctx: ExtensionContext): Promise<SourceItem[]>;
  /** Before classification (inbound texts). */
  beforeClassify?(ctx: ExtensionContext): Promise<void>;
  /** After filing, with the exhibits created or versioned this run (timestamping). */
  afterFiling?(ctx: ExtensionContext, filed: ExhibitRecord[]): Promise<void>;
  /** After founder decisions and new research (archiving approved sources). */
  afterReview?(ctx: ExtensionContext): Promise<void>;
  /** After letter requests (signature requests). */
  afterLetters?(ctx: ExtensionContext): Promise<void>;
  /** After the scorecard is written (digests, nudges, the first-scorecard text). */
  afterScorecard?(ctx: ExtensionContext): Promise<void>;
}

export interface AgentDeps {
  apps: Apps;
  ledger: Ledger;
  tracer: Tracer;
  profile: FounderProfile;
  model: EvidenceModel;
  graph: PromptGraph;
  researcher: Researcher;
  fetcher: WebFetcher;
  policy: SourcePolicy;
  gate: WorthSendingGate;
  clock: Clock;
  release: string;
  /** `twins.extend` for Arga runs; a no-op live. */
  extend: () => Promise<void>;
  mode: 'harness' | 'watch' | 'demo';
  scenarioId?: string | null;
  attempt?: number | null;
  ruleOptions?: RuleOptions;
  features?: { corroborate?: boolean; letters?: boolean };
  extensions?: AgentExtension[];
  /** Verifier APIs consulted before any web search (6.14). */
  structured?: StructuredResearch;
}

export interface RunSummary {
  runId: string;
  traceId: string;
  outcome: 'ok' | 'degraded';
  itemsRead: number;
  candidates: number;
  filed: string[];
  hallucinations: string[];
  modelCalls: number;
  review: ReviewSummary | null;
  corroboration: CorroborateSummary | null;
  letters: LetterSummary | null;
  scorecard: Scorecard | null;
  scorecardText: string | null;
  issues: AuditIssue[];
  degraded: string[];
  extensionErrors: { extension: string; hook: string; error: string }[];
  durationMs: number;
  summary: Record<string, unknown>;
}

async function sharingWarnings(apps: Apps, binder: BinderIds, owner: string): Promise<string[]> {
  const warnings: string[] = [];
  const check = async (id: string, label: string) => {
    for (const p of await apps.drive.listPermissions(id)) {
      if (p.role !== 'owner' || (p.emailAddress && p.emailAddress.toLowerCase() !== owner.toLowerCase())) {
        warnings.push(`${label} is shared with ${p.emailAddress ?? p.type} (${p.role})`);
      }
    }
  };
  await check(binder.root, 'Exhibit binder');
  for (const child of await apps.drive.listChildren(binder.root)) await check(child.id, `Exhibit binder/${child.name}`);
  await check(binder.reviewRoot, 'Exhibit review');
  return warnings;
}

async function eachExtension(ctx: ExtensionContext, hook: string, fn: (e: AgentExtension) => Promise<unknown> | undefined): Promise<void> {
  for (const e of ctx.deps.extensions ?? []) {
    try {
      await fn(e);
    } catch (err) {
      if (err instanceof TwinStubError || err instanceof DegradedRunError) throw err;
      ctx.summary.extensionErrors.push({ extension: e.name, hook, error: String(err) });
      ctx.trace.tool(`extension.${e.name}.${hook}`, { extension: e.name }, undefined, String(err));
      ctx.deps.ledger.event({ run_id: ctx.runId, trace_id: ctx.trace.traceId, kind: 'extension_error', detail: { extension: e.name, hook, error: String(err) }, at: ctx.now.toISOString() });
      if (!ctx.summary.degraded.includes(e.name)) ctx.summary.degraded.push(e.name);
    }
  }
}

export async function runExhibit(deps: AgentDeps, opts: { runId?: string } = {}): Promise<RunSummary> {
  const { ledger, tracer, profile, clock } = deps;
  const now = clock.now();
  const runId = opts.runId ?? `run_${now.toISOString().replace(/[-:.TZ]/g, '')}_${randomUUID().slice(0, 8)}`;
  const started = Date.now();
  ledger.startRun({ run_id: runId, scenario_id: deps.scenarioId ?? null, attempt: deps.attempt ?? null, release: deps.release, trace_id: null, started_at: now.toISOString(), mode: deps.mode });

  const { result, traceId } = await tracer.run(
    {
      name: 'exhibit',
      runId,
      input: { mode: deps.mode, scenario: deps.scenarioId ?? null, attempt: deps.attempt ?? null, release: deps.release, model: deps.model.modelId },
      // PRD 6.10: batch runs stay unthreaded (no threadId) so their issues appear immediately.
      // PRD 12.6: every trace carries the scenario id and the git SHA as the release.
      metadata: { release: deps.release, scenario_id: deps.scenarioId ?? '' },
    },
    async (trace) => {
    const s: RunSummary = {
      runId,
      traceId: trace.traceId,
      outcome: 'ok',
      itemsRead: 0,
      candidates: 0,
      filed: [],
      hallucinations: [],
      modelCalls: 0,
      review: null,
      corroboration: null,
      letters: null,
      scorecard: null,
      scorecardText: null,
      issues: [],
      degraded: [],
      extensionErrors: [],
      durationMs: 0,
      summary: {},
    };
    try {
      await pipeline(deps, trace, runId, now, s);
    } catch (err) {
      if (err instanceof TwinStubError) throw err;
      if (!(err instanceof DegradedRunError)) throw err;
      s.outcome = 'degraded';
      s.degraded.push(err.app);
      trace.span('run.degraded', { app: err.app }, { outcome: 'degraded' });
    }
    s.issues = auditRun({ runId, traceId: trace.traceId, events: tracer.events({ traceId: trace.traceId }), ledger, profile, scorecardText: s.scorecardText, computedO1Met: s.scorecard?.o1Met ?? null });
    for (const issue of s.issues) ledger.event({ run_id: runId, trace_id: trace.traceId, kind: 'audit_issue', detail: { ...issue }, at: now.toISOString() });
    s.durationMs = Date.now() - started;
    s.summary = {
      outcome: s.outcome,
      items_read: s.itemsRead,
      candidates: s.candidates,
      filed: s.filed.length,
      figures_queued: s.corroboration?.queued.length ?? 0,
      letters_sent: s.letters?.sent.length ?? 0,
      o1a_met: s.scorecard?.o1Met ?? null,
      eb1a_met: s.scorecard?.eb1Met ?? null,
      issues: s.issues.length,
      extension_errors: s.extensionErrors.length,
    };
    return s;
  });
  ledger.finishRun(runId, traceId, result.outcome, clock.now().toISOString());
  return { ...result, traceId };
}

async function pipeline(deps: AgentDeps, trace: TraceContext, runId: string, now: Date, s: RunSummary): Promise<void> {
  const { apps, ledger, profile, graph } = deps;
  const filerDeps = { drive: apps.drive, ledger, trace, profile, runId, now };
  let binder: BinderIds;
  let driveOk = true;
  try {
    binder = await ensureBinder(filerDeps);
  } catch (err) {
    if (err instanceof TwinStubError || err instanceof DegradedRunError) throw err;
    // Drive is down before mapping can even begin: still classify, map and verify, and upsert
    // candidates into the ledger, but skip filing (items stay queued, no exhibit_id) (PRD 10).
    driveOk = false;
    if (!s.degraded.includes('drive')) s.degraded.push('drive');
    trace.tool('drive.binder.ensure', { root: BINDER_ROOT }, undefined, String(err));
    binder = { root: '', folders: {}, needsAttorney: '', eb1aOnly: '', context: '', reviewRoot: '', staging: '', denied: '' };
  }

  // Intake (6.1), then discovery sources (6.14).
  const { items, context } = await intake({ apps, profile, ledger, trace, now, extend: deps.extend });
  s.degraded.push(...context.degraded);
  const ctx: ExtensionContext = { deps, trace, runId, now, binder, context, summary: s };
  await eachExtension(ctx, 'discover', async (e) => {
    if (!e.discover) return;
    for (const found of await e.discover(ctx)) if (ledger.itemSeen(found.app, found.id)?.stage !== 'done') items.push(found);
  });
  s.itemsRead = items.length;
  await eachExtension(ctx, 'beforeClassify', (e) => e.beforeClassify?.(ctx));

  // Redact, classify, map (6.2 to 6.4).
  const candidates: Candidate[] = [];
  const safeItems = new Map<string, SourceItem>();
  for (const item of items) {
    const redacted = redactItem(item);
    if (redacted.redactions.length) trace.span('redact', { app: item.app, id: item.id }, { redactions: redacted.redactions });
    // Everything downstream of here sees redacted title and text; only the filer touches `raw`.
    const safe: SourceItem = { ...item, title: redacted.title, text: redacted.text };
    safeItems.set(`${item.app}:${item.id}`, safe);
    const prior = ledger.itemSeen(item.app, item.id);
    const out = await classifyAndMap(item, redacted, { model: deps.model, profile, graph, trace, now, ruleOptions: deps.ruleOptions }, prior?.attempts ?? 0);
    s.modelCalls += out.modelCalls;
    s.hallucinations.push(...out.hallucinations);
    if (out.stage === 'retry') {
      ledger.markItem(item.app, item.id, runId, 'retry', { classification: out.cls });
      continue;
    }
    if (!out.mapping) {
      ledger.markItem(item.app, item.id, runId, 'done', { classification: out.cls });
      continue;
    }
    candidates.push({ item: safe, cls: out.cls, mapping: out.mapping });
    ledger.markItem(item.app, item.id, runId, 'mapped', { classification: out.cls, mapping: out.mapping });
  }
  s.candidates = candidates.length;

  // Verify (6.5) and file (6.6).
  const verified = verify(candidates, safeItems, { profile, ledger, founderMessages: context.founderMessages, now });
  const filedThisRun: ExhibitRecord[] = [];
  for (const v of verified) {
    let record: ExhibitRecord | null = null;
    if (driveOk) {
      const before = ledger.exhibitByKey(v.key)?.exhibit_id ?? null;
      record = await fileVerified(v, binder, filerDeps);
      if (record && record.exhibit_id !== before) {
        filedThisRun.push(record);
        if (record.version === 1) s.filed.push(record.exhibit_id);
      }
    }
    ledger.upsertCandidate({
      key: v.key,
      status: v.mapping.status,
      eb1a_status: v.mapping.eb1a_status,
      criteria: v.mapping.criteria,
      mapping: v.mapping,
      title: v.title,
      issuer: v.issuer,
      event_date: isoDay(v.event_date),
      url: v.url,
      sources: v.sources,
      checks: v.checks,
      exhibit_id: record?.exhibit_id ?? null,
      updated_run: runId,
    });
    // Without a binder nothing was filed, so leave the source items queued for the next run to file.
    if (driveOk) for (const m of v.members) ledger.markItem(m.app, m.id, runId, 'done', { candidateKey: v.key });
  }
  if (driveOk) {
    for (const c of candidates) if (ledger.itemSeen(c.item.app, c.item.id)?.stage === 'mapped') ledger.markItem(c.item.app, c.item.id, runId, 'done');
    await eachExtension(ctx, 'afterFiling', (e) => e.afterFiling?.(ctx, filedThisRun));
    await writeBinderIndexes(binder, filerDeps);
  }

  // Founder decisions from the last run first, then new research (6.11, 6.12).
  const reviewDeps = { apps, ledger, trace, profile, binder, runId, now };
  if (deps.features?.corroborate !== false) {
    s.review = await applyDecisions(reviewDeps);
    for (const app of s.review.degraded) if (!s.degraded.includes(app)) s.degraded.push(app);
    s.corroboration = await corroborate(ledger.exhibits(), { drive: apps.drive, ledger, trace, graph, researcher: deps.researcher, fetcher: deps.fetcher, policy: deps.policy, binder, runId, now, structured: deps.structured, profile });
    const { digestSent, degraded: queueDegraded } = await queueFigures(s.corroboration.queued, reviewDeps);
    s.review.digestSent = digestSent;
    for (const app of queueDegraded) if (!s.degraded.includes(app)) s.degraded.push(app);
  }
  await eachExtension(ctx, 'afterReview', (e) => e.afterReview?.(ctx));

  // Letters (6.8, 6.9).
  if (deps.features?.letters !== false) {
    s.letters = await processLetters({ apps, ledger, trace, profile, gate: deps.gate, runId, now, allMessages: context.allMessages, founderMessages: context.founderMessages });
    for (const app of s.letters.degraded ?? []) if (!s.degraded.includes(app)) s.degraded.push(app);
  }
  await eachExtension(ctx, 'afterLetters', (e) => e.afterLetters?.(ctx));

  // Scorecard (6.7).
  const warnings = driveOk ? await sharingWarnings(apps, binder, profile.emails[0]!) : [];
  s.scorecard = buildScorecard(ledger, profile, now, { followers: context.followers, degraded: [...new Set([...context.degraded, ...s.degraded])], sharingWarnings: warnings });
  s.scorecardText = renderScorecard(s.scorecard, profile);
  const docId = await writeScorecard(apps.docs, ledger, s.scorecardText);
  if (docId === null && !s.degraded.includes('docs')) s.degraded.push('docs');
  trace.tool('docs.scorecard.write', { documentId: docId }, { o1a_met: s.scorecard.o1Met, eb1a_met: s.scorecard.eb1Met, next_action: s.scorecard.nextAction });
  await eachExtension(ctx, 'afterScorecard', (e) => e.afterScorecard?.(ctx));
}
