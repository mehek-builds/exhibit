import type { DriveApi } from '../apps/types.js';
import { renderPdf } from '../binder/pdf.js';
import type { BinderIds } from '../binder/filer.js';
import type { FigureRow, FigureSource, Ledger } from '../ledger.js';
import type { TraceContext } from '../observability/tracer.js';
import type { PromptGraph } from '../rules/graph.js';
import { renderPrompt } from '../rules/graph.js';
import type { ApiCandidate, StructuredResearch } from '../integrations/types.js';
import type { ExhibitRecord, FigureLabel, FounderProfile, O1Criterion } from '../types.js';
import { domainOf, hostMatches, isoDay, parseFigure, sha256, uniq } from '../util.js';
import type { ResearchCandidate, Researcher, WebFetcher } from './types.js';

// The Corroborator (PRD 6.11). All five steps must pass before a figure reaches the review queue:
// research, fetch-and-check in code, two sources with at least one primary, agreement, freshness.
// Allowed domains are enforced twice: passed to the web tools, and re-checked here on every URL.

export interface SourcePolicy {
  verifiers: string[];
  /** Official record-keepers (BLS, O*NET, SEC, USPTO): primary sources for their own records. */
  recordKeepers: string[];
  never: string[];
  tolerance: number;
  freshnessMonths: number;
}

export function sourcePolicy(graph: PromptGraph, includeSynthetic: boolean): SourcePolicy {
  const data = graph.fragments.get('source-lists')?.data as { verifiers: string[]; synthetic_verifiers: string[]; record_keepers?: string[]; never: string[]; agreement_tolerance: number; freshness_months: number };
  return {
    verifiers: [...data.verifiers, ...(includeSynthetic ? data.synthetic_verifiers : [])],
    recordKeepers: data.record_keepers ?? [],
    never: data.never,
    tolerance: data.agreement_tolerance,
    freshnessMonths: data.freshness_months,
  };
}

export interface CorroborateDeps {
  drive: DriveApi;
  ledger: Ledger;
  trace: TraceContext;
  graph: PromptGraph;
  researcher: Researcher;
  fetcher: WebFetcher;
  policy: SourcePolicy;
  binder: BinderIds;
  runId: string;
  now: Date;
  /** Cap on research calls per run (search cost, 7.5b). */
  maxExhibits?: number;
  /** Verifier APIs queried before any web search (6.14 "structured sources first"). */
  structured?: StructuredResearch;
  profile?: FounderProfile;
}

export interface CorroborateSummary {
  researched: number;
  proposed: number;
  queued: FigureRow[];
  blocked: { url: string; reason: string }[];
  hallucinations: { url: string; sentence: string }[];
  conflicting: number;
  insufficient: number;
  cacheHits: number;
  /** Exhibits deferred to the next run because a free-tier limit was hit (E68). */
  limited: number;
  errors: string[];
}

interface CheckedSource extends FigureSource {
  measure: string;
  value: number;
  unit: string;
}

function textOf(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function monthsBetween(a: string, b: Date): number {
  const d = new Date(a);
  return (b.getFullYear() - d.getFullYear()) * 12 + (b.getMonth() - d.getMonth());
}

export function allowedDomainsFor(exhibit: ExhibitRecord, policy: SourcePolicy): string[] {
  const issuer = exhibit.issuer && exhibit.issuer !== 'github.com' ? [exhibit.issuer] : [];
  const fromSources = exhibit.sources.map((s) => domainOf(s.url)).filter((d): d is string => !!d && !policy.never.some((n) => hostMatches(d, n)));
  const platform = exhibit.issuer === 'github.com' ? ['github.com', 'api.github.com'] : [];
  return uniq([...issuer, ...fromSources.filter((d) => d !== 'google.com'), ...platform, ...policy.verifiers, ...policy.recordKeepers]).filter((d) => !policy.never.some((n) => hostMatches(d, n)));
}

function fingerprint(exhibitId: string, measure: string, urls: string[]): string {
  return sha256(`${exhibitId.split('.v')[0]}|${measure.toLowerCase()}|${[...urls].sort().join('|')}`);
}

function fmt(n: number): string {
  return n >= 1000 ? n.toLocaleString('en-US') : String(n);
}

export async function corroborate(exhibits: ExhibitRecord[], deps: CorroborateDeps): Promise<CorroborateSummary> {
  const { ledger, trace, researcher, fetcher, policy, now } = deps;
  const summary: CorroborateSummary = { researched: 0, proposed: 0, queued: [], blocked: [], hallucinations: [], conflicting: 0, insufficient: 0, cacheHits: 0, limited: 0, errors: [] };
  const targets = exhibits.filter((e) => e.status === 'qualifying' && !ledger.get(`corroborated:${e.exhibit_id.split('.v')[0]}`)).slice(0, deps.maxExhibits ?? 25);

  for (const exhibit of targets) {
    const criterion = exhibit.criteria[0] as O1Criterion | undefined;
    if (!criterion) continue;
    const issuerDomain = exhibit.issuer ?? '';
    const allowed = allowedDomainsFor(exhibit, policy);
    const cacheKey = `${issuerDomain}|${criterion}`;
    const cached = ledger.cacheGet<ResearchCandidate[]>(cacheKey);

    // Structured sources first: web search only for figures no API holds (6.14).
    let candidates: (ResearchCandidate | ApiCandidate)[] = [];
    let deferred = false;
    if (deps.structured) {
      let api: { candidates: ApiCandidate[]; errors: string[]; limited?: boolean };
      try {
        api = await deps.structured.propose({ exhibit, criterion, issuerDomain, allowedDomains: allowed, systemPrompt: renderPrompt(deps.graph, 'corroborator'), profile: deps.profile });
      } catch (err) {
        // The verifier API is hard down: never fall back to web search for a figure it should have
        // supplied (E68, constraint 14); defer the figure to the next run instead.
        summary.errors.push(String(err));
        trace.tool('corroborator.structured', { structured: deps.structured.kind, issuer: issuerDomain, criterion }, undefined, String(err));
        summary.limited += 1;
        continue;
      }
      summary.errors.push(...api.errors);
      trace.tool('corroborator.structured', { structured: deps.structured.kind, issuer: issuerDomain, criterion }, { candidates: api.candidates.length, limited: api.limited }, api.errors.length ? api.errors.join('; ') : undefined);
      if (api.limited || (api.errors.length > 0 && api.candidates.length === 0)) {
        // A free-tier limit, or the API itself came back as an error (e.g. HTTP 5xx): the figure
        // waits for the next run; it is never filled from another source class (E68).
        summary.limited += 1;
        continue;
      }
      candidates = api.candidates;
    }
    if (candidates.length === 0) {
      if (cached && monthsBetween(cached.fetched_at, now) < policy.freshnessMonths) {
        candidates = cached.payload;
        summary.cacheHits += 1;
        trace.span('corroborator.cache_hit', { issuer: issuerDomain, criterion }, { candidates: candidates.length });
      } else {
        let res: { candidates: ResearchCandidate[]; searches: number; errors: string[] };
        try {
          res = await researcher.propose({ exhibit, criterion, issuerDomain, allowedDomains: allowed, systemPrompt: renderPrompt(deps.graph, 'corroborator'), profile: deps.profile });
        } catch (err) {
          // Web search itself failed to run (not a tool-error-in-200): record and retry next run.
          summary.errors.push(String(err));
          trace.tool('corroborator.research', { researcher: researcher.kind, issuer: issuerDomain, criterion, allowed_domains: allowed }, undefined, String(err));
          deferred = true;
          candidates = [];
          res = { candidates: [], searches: 0, errors: [] };
        }
        if (!deferred) {
          summary.researched += 1;
          candidates = res.candidates;
          summary.errors.push(...res.errors);
          trace.tool('corroborator.research', { researcher: researcher.kind, issuer: issuerDomain, criterion, allowed_domains: allowed }, { candidates: candidates.length, searches: res.searches }, res.errors.length ? res.errors.join('; ') : undefined);
          if (res.errors.length > 0 && res.candidates.length === 0) {
            // A server-tool error came back inside HTTP 200 (7.5b): nothing to cache, and the
            // exhibit must not be marked corroborated, or it is never researched again.
            deferred = true;
          } else {
            ledger.cacheSet(cacheKey, candidates, now.toISOString());
          }
        }
      }
    }
    if (deferred) continue;
    summary.proposed += candidates.length;

    // Steps 1-2: domain and fetch-and-check, in code.
    const checked: CheckedSource[] = [];
    let fetchAttempts = 0;
    let fetchThrows = 0;
    for (const cand of candidates) {
      const host = domainOf(cand.url);
      if (!host || policy.never.some((n) => hostMatches(host, n)) || !allowed.some((a) => hostMatches(host, a))) {
        summary.blocked.push({ url: cand.url, reason: 'domain not on the primary or verifier list' });
        ledger.event({ run_id: deps.runId, trace_id: trace.traceId, kind: 'source_blocked', detail: { exhibit_id: exhibit.exhibit_id, url: cand.url, measure: cand.measure }, at: now.toISOString() });
        trace.span('corroborator.blocked', { url: cand.url, measure: cand.measure }, { reason: 'domain' });
        continue;
      }
      const recordKeeper = policy.recordKeepers.some((r) => hostMatches(host, r));
      const kindOk =
        cand.kind === 'verifier'
          ? policy.verifiers.some((v) => hostMatches(host, v))
          : (cand.kind === 'primary' && recordKeeper) ||
            (!policy.verifiers.some((v) => hostMatches(host, v)) && (hostMatches(host, issuerDomain) || exhibit.sources.some((s) => domainOf(s.url) === host)));
      if (!kindOk) {
        summary.blocked.push({ url: cand.url, reason: `source kind ${cand.kind} does not match the domain` });
        trace.span('corroborator.blocked', { url: cand.url, kind: cand.kind }, { reason: 'kind' });
        continue;
      }
      // An API figure's snapshot is the API response itself; web figures are fetched by code.
      const isApi = (cand as ApiCandidate).source_class === 'api';
      let page;
      if (isApi) {
        page = { url: cand.url, status: 200, contentType: 'application/json', body: (cand as ApiCandidate).response };
      } else {
        fetchAttempts += 1;
        try {
          page = await fetcher.fetch(cand.url);
        } catch (err) {
          fetchThrows += 1;
          trace.tool('web.fetch', { url: cand.url }, undefined, String(err));
          continue;
        }
        trace.tool('web.fetch', { url: cand.url, fetcher: fetcher.kind }, { status: page.status, bytes: page.body.length });
        // Redirects can land the fetch off the allowlist even though `cand.url` passed the check
        // above; re-check the final URL's host before trusting anything fetched from it.
        const finalHost = domainOf(page.url);
        if (!finalHost || policy.never.some((n) => hostMatches(finalHost, n)) || !allowed.some((a) => hostMatches(finalHost, a))) {
          summary.blocked.push({ url: page.url, reason: 'redirected off the primary or verifier list' });
          ledger.event({ run_id: deps.runId, trace_id: trace.traceId, kind: 'source_blocked', detail: { exhibit_id: exhibit.exhibit_id, url: page.url, measure: cand.measure }, at: now.toISOString() });
          trace.span('corroborator.blocked', { url: page.url, measure: cand.measure }, { reason: 'redirect_domain' });
          continue;
        }
      }
      if (page.status !== 200) {
        summary.blocked.push({ url: cand.url, reason: `status ${page.status} (paywalled or blocked)` });
        continue;
      }
      const pageText = textOf(page.body);
      const sentence = cand.sentence.replace(/\s+/g, ' ').trim();
      const numberInSentence = parseFigure(sentence);
      const sentenceOnPage = pageText.includes(sentence);
      if (!sentenceOnPage || numberInSentence === null || Math.abs(numberInSentence - cand.value) > Math.max(1, cand.value * 0.001)) {
        summary.hallucinations.push({ url: cand.url, sentence: cand.sentence });
        ledger.event({ run_id: deps.runId, trace_id: trace.traceId, kind: 'figure_hallucination', detail: { exhibit_id: exhibit.exhibit_id, url: cand.url, sentence: cand.sentence, value: cand.value }, at: now.toISOString() });
        trace.span('hallucination.figure', { url: cand.url, sentence: cand.sentence, value: cand.value }, { on_page: sentenceOnPage, number_in_sentence: numberInSentence });
        continue;
      }
      const htmlFile = await deps.drive.createFile({
        parentId: deps.binder.staging,
        name: `${sha256(cand.url).slice(0, 12)}-${isoDay(now.toISOString())}.${isApi ? 'json' : 'html'}`,
        mimeType: isApi ? 'application/json' : 'text/html',
        content: page.body,
      });
      const pdfFile = await deps.drive.createFile({
        parentId: deps.binder.staging,
        name: `${sha256(cand.url).slice(0, 12)}-${isoDay(now.toISOString())}.pdf`,
        mimeType: 'application/pdf',
        content: renderPdf({ heading: `Snapshot of ${cand.url}`, subheading: `Fetched ${now.toISOString()} by Exhibit`, body: pageText, highlights: [sentence] }),
      });
      checked.push({ source_class: isApi ? 'api' : 'web', kind: cand.kind, url: cand.url, publisher: cand.publisher, sentence, snapshot_html_id: htmlFile.id, snapshot_pdf_id: pdfFile.id, snapshot_sha256: htmlFile.sha256!, as_of: cand.as_of, measure: cand.measure, value: cand.value, unit: cand.unit });
    }

    // Web fetch is down: every fetch for this exhibit threw. Never record insufficient_sources or
    // mark the exhibit corroborated on the strength of a fault; leave it queued for retry.
    if (fetchAttempts > 0 && fetchThrows === fetchAttempts) continue;

    // Steps 3-5 per measure.
    for (const measure of uniq(candidates.map((c) => c.measure))) {
      const forMeasure = checked.filter((c) => c.measure === measure);
      const primary = forMeasure.find((c) => c.kind === 'primary');
      const verifier = forMeasure.find((c) => c.kind === 'verifier');
      const second = verifier ?? forMeasure.find((c) => c.kind === 'issuer_second' && c.url !== primary?.url);
      const unit = candidates.find((c) => c.measure === measure)!.unit;

      const base = {
        exhibit_id: exhibit.exhibit_id,
        criterion,
        measure,
        unit,
        run_id: deps.runId,
        trace_id: trace.traceId,
        queued_at: null,
        decided_at: null,
        decision_reason: null,
      };
      if (!primary || !second) {
        const missing = !primary ? 'no primary source passed the checks' : 'no second valid source (verifier or second issuer document)';
        const fp = fingerprint(exhibit.exhibit_id, measure, forMeasure.map((c) => c.url));
        if (!ledger.figureByFingerprint(fp)) {
          ledger.insertFigure({ ...base, fig_id: ledger.nextFigureId(), value: primary?.value ?? second?.value ?? 0, as_of: (primary ?? second)?.as_of ?? '', sources: forMeasure, label: null, note: '', status: 'insufficient_sources', fingerprint: fp, detail: missing });
        }
        summary.insufficient += 1;
        continue;
      }
      const fp = fingerprint(exhibit.exhibit_id, measure, [primary.url, second.url]);
      if (ledger.isDenied(fp)) {
        trace.span('corroborator.skip_denied', { exhibit_id: exhibit.exhibit_id, measure }, { fingerprint: fp });
        continue;
      }
      if (ledger.figureByFingerprint(fp)) continue;

      const conflictReason =
        primary.unit !== second.unit
          ? `different measures (${primary.unit} vs ${second.unit})`
          : Math.abs(primary.value - second.value) / Math.max(primary.value, second.value) > policy.tolerance
            ? `values differ by more than ${policy.tolerance * 100}% (${fmt(primary.value)} vs ${fmt(second.value)})`
            : null;
      if (conflictReason) {
        ledger.insertFigure({ ...base, fig_id: ledger.nextFigureId(), value: Math.min(primary.value, second.value), as_of: primary.as_of, sources: [primary, second], label: null, note: '', status: 'conflicting', fingerprint: fp, detail: conflictReason });
        summary.conflicting += 1;
        trace.span('corroborator.conflicting', { exhibit_id: exhibit.exhibit_id, measure }, { reason: conflictReason });
        continue;
      }
      const oldest = [primary.as_of, second.as_of].sort()[0]!;
      if (monthsBetween(oldest, now) >= policy.freshnessMonths) {
        trace.span('corroborator.stale', { exhibit_id: exhibit.exhibit_id, measure, as_of: oldest }, { requeue: true });
        continue;
      }
      const label: FigureLabel = second.kind === 'verifier' ? 'independently_confirmed' : 'issuer_confirmed';
      const value = Math.min(primary.value, second.value);
      const asOf = new Date(oldest).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      const note = `${primary.publisher} reports ${measure} of about ${fmt(value)} ${unit}, per ${primary.publisher} (${primary.kind}) and ${second.publisher} (${second.kind === 'verifier' ? 'verifier' : 'second issuer document'}), as of ${asOf}.`;
      const row: FigureRow = { ...base, fig_id: ledger.nextFigureId(), value, as_of: oldest, sources: [primary, second], label, note, status: 'pending', fingerprint: fp, detail: null, queued_at: now.toISOString() };
      ledger.insertFigure(row);
      summary.queued.push(row);
    }
    ledger.set(`corroborated:${exhibit.exhibit_id.split('.v')[0]}`, now.toISOString());
  }
  trace.span('corroborator.summary', { exhibits: targets.length }, { ...summary, queued: summary.queued.map((q) => q.fig_id) });
  return summary;
}
