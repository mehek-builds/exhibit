import type { EvidenceModel } from '../models/types.js';
import type { TraceContext } from '../observability/tracer.js';
import type { PromptGraph } from '../rules/graph.js';
import { allRuleIds, renderPrompt } from '../rules/graph.js';
import type { RuleOptions } from '../rules/explicit.js';
import { applyExplicitRules, enforceInvariants, fullText, mapping as mkMapping, O1_TO_EB1 } from '../rules/explicit.js';
import { classifyStructured } from '../rules/structured.js';
import type { Classification, FounderProfile, Mapping, RedactedItem, SourceItem } from '../types.js';
import { prefilter } from './prefilter.js';

// Classifier then criterion mapper (PRD 6.3, 6.4). Explicit rules run before the model;
// invariants run after it; every quote must be an exact substring of the redacted item.

export interface MapDeps {
  model: EvidenceModel;
  profile: FounderProfile;
  graph: PromptGraph;
  trace: TraceContext;
  now: Date;
  ruleOptions?: RuleOptions;
}

export interface MapOutcome {
  cls: Classification;
  mapping: Mapping | null;
  /** `retry`: leave the item unprocessed for the next run (E17 re-queue once, E29 model failure). */
  stage: 'done' | 'retry';
  hallucinations: string[];
  modelCalls: number;
}

async function withOneRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    return fn();
  }
}

export async function classifyAndMap(item: SourceItem, redacted: RedactedItem, deps: MapDeps, priorAttempts: number): Promise<MapOutcome> {
  const { model, profile, graph, trace } = deps;
  const hallucinations: string[] = [];
  let modelCalls = 0;

  const dropped = prefilter(item, profile);
  if (dropped) {
    trace.span('prefilter.drop', { app: item.app, id: item.id }, { reason: dropped });
    return { cls: { is_candidate: false, kind: 'other', quote: '', decided_by: 'prefilter', reason: dropped }, mapping: null, stage: 'done', hallucinations, modelCalls };
  }

  const structured = classifyStructured(item, profile, deps.now);
  if (structured) {
    trace.span('classify.structured', { app: item.app, id: item.id }, { is_candidate: structured.cls.is_candidate, rule: structured.mapping?.rule_id ?? null });
    return { cls: structured.cls, mapping: structured.mapping, stage: 'done', hallucinations, modelCalls };
  }

  const text = fullText(redacted);
  let cls: Classification;
  try {
    const call = await withOneRetry(() => model.classify(redacted, renderPrompt(graph, 'classifier')));
    modelCalls += 1;
    trace.generation('classify', model.modelId, { item: { app: item.app, id: item.id }, prompt: call.prompt }, call.output);
    cls = { ...call.output, decided_by: 'model' };
  } catch (err) {
    trace.generation('classify', model.modelId, { item: { app: item.app, id: item.id } }, undefined, String(err));
    return { cls: { is_candidate: false, kind: 'other', quote: '', decided_by: 'model', reason: 'model failed twice' }, mapping: null, stage: 'retry', hallucinations, modelCalls };
  }

  if (!cls.is_candidate) return { cls, mapping: null, stage: 'done', hallucinations, modelCalls };
  if (cls.quote && !text.includes(cls.quote)) {
    hallucinations.push(`classifier quote not found in ${item.app}:${item.id}`);
    trace.span('hallucination.quote', { stage: 'classify', app: item.app, id: item.id, quote: cls.quote }, { discarded: true });
    cls = { ...cls, quote: '' };
  }

  const explicit = applyExplicitRules(redacted, cls, profile, deps.ruleOptions);
  if (explicit) {
    trace.span('map.explicit_rule', { app: item.app, id: item.id }, { rule_id: explicit.rule_id, criteria: explicit.criteria, status: explicit.status });
    return { cls, mapping: explicit, stage: 'done', hallucinations, modelCalls };
  }

  let raw;
  try {
    const call = await withOneRetry(() => model.map(redacted, cls, renderPrompt(graph, 'mapper')));
    modelCalls += 1;
    raw = call.output;
    trace.generation('map', model.modelId, { item: { app: item.app, id: item.id }, prompt: call.prompt }, raw);
  } catch (err) {
    trace.generation('map', model.modelId, { item: { app: item.app, id: item.id } }, undefined, String(err));
    return { cls, mapping: null, stage: 'retry', hallucinations, modelCalls };
  }

  const knownRules = allRuleIds(graph);
  let m: Mapping = {
    criteria: raw.criteria,
    eb1a_criteria: raw.criteria.map((c) => O1_TO_EB1[c]),
    status: raw.status,
    eb1a_status: raw.status,
    comparable_for: raw.comparable_for ?? [],
    rule_id: raw.rule_id,
    reason: raw.reason,
    quote: raw.quote,
    decided_by: 'model',
  };

  if (!text.includes(m.quote)) {
    hallucinations.push(`mapper quote not found in ${item.app}:${item.id}`);
    trace.span('hallucination.quote', { stage: 'map', app: item.app, id: item.id, quote: m.quote }, { discarded: true, priorAttempts });
    if (priorAttempts < 1) return { cls, mapping: null, stage: 'retry', hallucinations, modelCalls };
    m = mkMapping(m.criteria, 'needs_attorney', 'V-quote-not-found', 'The mapper quote was not found in the item twice; kept for the attorney.', cls.quote || item.title, { decided_by: 'model' });
  }
  if (!knownRules.includes(m.rule_id)) {
    trace.span('map.unknown_rule', { app: item.app, id: item.id, rule_id: m.rule_id }, { downgraded: true });
    m = { ...m, status: m.status === 'rejected' ? 'rejected' : 'needs_attorney', eb1a_status: m.status === 'rejected' ? 'rejected' : 'needs_attorney', rule_id: 'N-unmapped', reason: `Model cited an unknown rule (${m.rule_id}).` };
  }
  m = enforceInvariants(m, redacted, profile, deps.ruleOptions);
  return { cls, mapping: m, stage: 'done', hallucinations, modelCalls };
}
