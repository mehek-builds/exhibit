import type { RunSummary } from '../src/agent.js';
import { runExhibit } from '../src/agent.js';
import type { Apps, TwilioApi } from '../src/apps/types.js';
import { AppUnavailableError, TwinExpiredError } from '../src/apps/types.js';
import type { DropboxSignClient } from '../src/integrations/dropboxsign.js';
import type { HttpRequest, HttpResponse, HttpTransport, StructuredResearch } from '../src/integrations/types.js';
import { UnavailableGate } from '../src/letters/worthSending.js';
import type { GateDecision } from '../src/letters/worthSending.js';
import type { EvidenceModel, ModelCall, ModelClassification, ModelMapping } from '../src/models/types.js';
import { LemmaTracer } from '../src/observability/tracer.js';
import type { FetchResult, ResearchRequest, ResearchResult, Researcher, WebFetcher } from '../src/research/types.js';
import type { HarnessEnv } from './env.js';

// Fault injection for the degraded-modes suite (PRD 10). Every helper wraps or stands beside the
// real object and makes exactly one dependency fail on demand; none of them reimplement business
// logic, and none edit an implementation file. Wrappers that can recover expose a mutable `down`
// flag so a test can prove "queued and retried" by healing the dependency between runs.

export type AppName = 'sheets' | 'docs' | 'drive' | 'gmail' | 'calendar' | 'github' | 'linkedin';
export type AppFailMode = 'throw' | '410' | 'unavailable';

/** The error a real outage of `app` surfaces as: a generic network error, a lapsed twin, or the code's own "unavailable" signal. */
export function appFault(app: string, mode: AppFailMode): Error {
  if (mode === '410') return new TwinExpiredError(app);
  if (mode === 'unavailable') return new AppUnavailableError(app);
  return new Error(`${app} request failed: connect ECONNREFUSED (injected fault)`);
}

export interface Switch {
  /** While true every call fails; set false to let the dependency recover. */
  down: boolean;
  /** Method names that were called while down. */
  attempts: string[];
}

/**
 * Proxies every method of `target`: while `sw.down`, a call records its name and rejects with
 * `makeError(method)`; otherwise it forwards to the real object. Non-function properties
 * (`sender`, `testMode`, ...) always pass through.
 */
export function failAll<T extends object>(target: T, makeError: (method: string) => Error, sw: Switch = { down: true, attempts: [] }): T & { readonly fault: Switch } {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop === 'fault') return sw;
      const value = Reflect.get(obj, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (sw.down) {
          sw.attempts.push(String(prop));
          return Promise.reject(makeError(String(prop)));
        }
        return (value as (...a: unknown[]) => unknown).apply(obj, args);
      };
    },
  }) as T & { readonly fault: Switch };
}

/** A copy of the `apps` bag with one app client failing in `mode`. The original bag is untouched, so restoring is `env.deps.apps = original`. */
export function failingApp(apps: Apps, name: AppName, mode: AppFailMode): Apps & { fault: Switch } {
  const client = apps[name];
  if (!client) throw new Error(`apps.${name} is not configured`);
  const sw: Switch = { down: true, attempts: [] };
  const wrapped = failAll(client as object, () => appFault(name, mode), sw);
  return { ...apps, [name]: wrapped, fault: sw } as Apps & { fault: Switch };
}

/** The Anthropic API is down: every classify and map call throws. */
export class FailingModel implements EvidenceModel {
  readonly name = 'failing-model';
  readonly modelId = 'claude-sonnet-5 (injected outage)';
  calls = 0;
  async classify(): Promise<ModelCall<ModelClassification>> {
    this.calls += 1;
    throw new Error('Anthropic API unavailable: 529 overloaded (injected fault)');
  }
  async map(): Promise<ModelCall<ModelMapping>> {
    this.calls += 1;
    throw new Error('Anthropic API unavailable: 529 overloaded (injected fault)');
  }
}

export function failingModel(): FailingModel {
  return new FailingModel();
}

export type ResearcherFailMode = 'throw' | 'tool-error-200';

/**
 * Claude web search down. `throw`: the request itself fails. `tool-error-200`: HTTP 200 whose
 * web_search tool result carries an error object (7.5b), reported the way AnthropicResearcher does.
 */
export function failingResearcher(mode: ResearcherFailMode = 'throw'): Researcher & { requests: ResearchRequest[] } {
  const requests: ResearchRequest[] = [];
  return {
    kind: 'anthropic',
    requests,
    async propose(req: ResearchRequest): Promise<ResearchResult> {
      requests.push(req);
      if (mode === 'throw') throw new Error('Anthropic API unavailable: web search request failed (injected fault)');
      return { candidates: [], searches: 1, errors: ['web_search_tool_result: unavailable'] };
    },
  };
}

/** Records every request and forwards to `inner`; used to prove web search was (or was not) consulted. */
export function spyResearcher(inner: Researcher): Researcher & { requests: ResearchRequest[] } {
  const requests: ResearchRequest[] = [];
  return {
    kind: inner.kind,
    requests,
    propose(req: ResearchRequest) {
      requests.push(req);
      return inner.propose(req);
    },
  };
}

/** Web fetch down: every fetch throws (`throw`) or returns a 503 (`503`). */
export function failingFetcher(mode: 'throw' | '503' = 'throw'): WebFetcher & { requested: string[] } {
  const requested: string[] = [];
  return {
    kind: 'live',
    requested,
    async fetch(url: string): Promise<FetchResult> {
      requested.push(url);
      if (mode === 'throw') throw new Error(`web fetch failed for ${url} (injected fault)`);
      return { url, status: 503, contentType: 'text/html', body: '' };
    },
  };
}

export interface FailingStructuredOptions {
  /** Answers requests the fault does not apply to. Default: no candidates, not limited. */
  inner?: StructuredResearch;
  /** Which requests hit the outage. Default: all of them. */
  when?: (req: ResearchRequest) => boolean;
}

/** A verifier API in a free-tier limit (`limited`) or hard down (`throw`). */
export function failingStructured(mode: 'limited' | 'throw', opts: FailingStructuredOptions = {}): StructuredResearch & { requests: ResearchRequest[]; faulted: ResearchRequest[] } {
  const requests: ResearchRequest[] = [];
  const faulted: ResearchRequest[] = [];
  return {
    kind: 'verifier-apis (injected outage)',
    requests,
    faulted,
    async propose(req: ResearchRequest) {
      requests.push(req);
      if (!opts.when || opts.when(req)) {
        faulted.push(req);
        if (mode === 'throw') throw new Error('verifier API unavailable (injected fault)');
        return { candidates: [], errors: [], limited: true };
      }
      return opts.inner ? opts.inner.propose(req) : { candidates: [], errors: [], limited: false };
    },
  };
}

export interface FailingTransport extends HttpTransport, Switch {
  refused: HttpRequest[];
}

/**
 * Requests whose host matches `hostPattern` fail at the transport layer while `down`: they throw,
 * or, with `status`, come back as that HTTP status. Everything else goes to `transport`.
 */
export function failingTransport(transport: HttpTransport, hostPattern: RegExp | string, opts: { status?: number } = {}): FailingTransport {
  const re = typeof hostPattern === 'string' ? new RegExp(hostPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : hostPattern;
  const refused: HttpRequest[] = [];
  const t: FailingTransport = {
    kind: transport.kind,
    down: true,
    attempts: [],
    refused,
    async request(req: HttpRequest): Promise<HttpResponse> {
      let host = '';
      try {
        host = new URL(req.url).hostname;
      } catch {
        host = req.url;
      }
      if (t.down && re.test(host)) {
        refused.push(req);
        t.attempts.push(`${req.method} ${host}`);
        if (opts.status !== undefined) return { status: opts.status, headers: { 'content-type': 'text/plain' }, body: `${opts.status} (injected fault)` };
        throw new Error(`fetch failed: ${host} unreachable (injected fault)`);
      }
      return transport.request(req);
    },
  };
  return t;
}

// ---------- Lemma ----------

export type LemmaFailMode = 'start' | 'delivery' | 'record';

interface LemmaTraceLike {
  recordTool(e: unknown): void;
  recordGeneration(e: unknown): void;
  recordSpan(e: unknown): void;
}

/**
 * A stand-in for the `Lemma` client whose delivery always fails. `start`: `trace()` rejects before
 * running the callback. `delivery`: the callback runs, then ingest rejects. `record`: every
 * record call throws while the trace itself resolves.
 */
export function failingLemmaClient(mode: LemmaFailMode): { calls: number; trace<T>(opts: unknown, fn: (t: LemmaTraceLike) => Promise<T>): Promise<T> } {
  const client = {
    calls: 0,
    async trace<T>(_opts: unknown, fn: (t: LemmaTraceLike) => Promise<T>): Promise<T> {
      client.calls += 1;
      if (mode === 'start') throw new Error('lemma ingest unreachable (injected fault)');
      const thrower = () => {
        throw new Error('lemma record rejected (injected fault)');
      };
      const handle: LemmaTraceLike = mode === 'record' ? { recordTool: thrower, recordGeneration: thrower, recordSpan: thrower } : { recordTool() {}, recordGeneration() {}, recordSpan() {} };
      const out = await fn(handle);
      if (mode === 'delivery') throw new Error('lemma ingest returned 503 (injected fault)');
      return out;
    },
  };
  return client;
}

/** A real LemmaTracer whose Lemma client is replaced by a failing double (dummy keys; the real client never sends). */
export function lemmaTracerWith(client: ReturnType<typeof failingLemmaClient>): LemmaTracer {
  const tracer = new LemmaTracer({ apiKey: 'lemma_test_key', projectId: 'proj_test', release: 'degraded-test' });
  (tracer as unknown as { lemma: unknown }).lemma = client;
  return tracer;
}

// ---------- worth-sending ----------

/** worth-sending not running (E22, 7.3): the real UnavailableGate, counting how often the agent asked it. */
export class CountingUnavailableGate extends UnavailableGate {
  attempts = 0;
  override async evaluate(): Promise<GateDecision> {
    this.attempts += 1;
    return super.evaluate();
  }
}

export function unavailableGate(): CountingUnavailableGate {
  return new CountingUnavailableGate();
}

/** Swap the gate on a live env, the way a server crash mid-deployment would. */
export function takeGateDown(env: HarnessEnv): CountingUnavailableGate {
  const gate = unavailableGate();
  env.deps.gate = gate;
  return gate;
}

// ---------- Twilio and Dropbox Sign ----------

/** A Twilio client whose send and listInbound always throw. */
export function failingTwilio(sender = 'whatsapp:+15550009999'): TwilioApi & { readonly fault: Switch } {
  const inert: TwilioApi = {
    sender,
    async listInbound() {
      return [];
    },
    async send() {
      return { sid: 'never' };
    },
  };
  return failAll(inert, (m) => new Error(`twilio ${m} failed: 503 Service Unavailable (injected fault)`));
}

/** Dropbox Sign down: wraps a real client; every call fails while `fault.down`. */
export function failingDropboxSign(inner: DropboxSignClient): DropboxSignClient & { readonly fault: Switch } {
  return failAll(inner, (m) => new Error(`dropbox sign ${m} failed: 503 (injected fault)`));
}

// ---------- running ----------

/**
 * Runs once and returns the outcome instead of throwing, so the stops-doing column can be graded even
 * when a run rejects. Uses its own run ids: `env.run()` numbers runs by `env.runs.length`, which a
 * rejected run never joins, so a later `env.run()` would otherwise collide on the ledger's run id.
 */
export async function tryRun(env: HarnessEnv): Promise<{ summary: RunSummary | null; error: unknown }> {
  try {
    const summary = await runExhibit(env.deps, { runId: `degraded-r${env.ledger.runs().length + 1}` });
    env.runs.push(summary);
    return { summary, error: null };
  } catch (error) {
    return { summary: null, error };
  }
}
