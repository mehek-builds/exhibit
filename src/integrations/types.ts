import { redactText } from '../pipeline/redact.js';
import type { ResearchCandidate, ResearchRequest } from '../research/types.js';
import type { ExhibitRecord, FounderProfile, O1Criterion, SourceItem } from '../types.js';

// The one adapter interface behind the 6.14 integration lineup: a query in, normalized candidates or
// figures out, each with a source URL and a retrieval time. Every adapter takes an HttpTransport, so the
// same code runs live and against recorded fixtures (the open web and these APIs have no twins, 12.3).

export type IntegrationJob = 'discover' | 'verify' | 'integrity' | 'act' | 'after_filing';

export interface IntegrationInfo {
  id: string;
  name: string;
  job: IntegrationJob[];
  tier: 1 | 2 | 'sandbox';
  criteria: string;
  freeTier: string;
  credentials: string[];
  /** Exactly what this service receives (6.14 data table, constraint 17). */
  receives: string;
}

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  bytes?: Uint8Array;
}

export interface HttpTransport {
  readonly kind: 'live' | 'fixture';
  request(req: HttpRequest): Promise<HttpResponse>;
}

/**
 * An API error body is safe to put in an Error only after truncation and redaction: services echo
 * submitted fields back (a message body, source text), and errors flow into traces (constraint 8).
 */
export function safeErrorBody(body: string, max = 200): string {
  return redactText(body.length > max ? `${body.slice(0, max)}…` : body).text;
}

export class FetchTransport implements HttpTransport {
  readonly kind = 'live' as const;
  constructor(private readonly opts: { timeoutMs?: number; userAgent?: string } = {}) {}

  async request(req: HttpRequest): Promise<HttpResponse> {
    const res = await fetch(req.url, {
      method: req.method,
      headers: { 'user-agent': this.opts.userAgent ?? 'Exhibit/0.1 (evidence agent)', ...req.headers },
      body: req.body as never,
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: Buffer.from(bytes).toString('utf8'), bytes };
  }
}

/** Keyed by `${METHOD} ${url}`; a key without the query string also matches. Unknown requests get a 404. */
export type FixtureMap = Record<string, HttpResponse | ((req: HttpRequest) => HttpResponse)>;

export class FixtureTransport implements HttpTransport {
  readonly kind = 'fixture' as const;
  readonly requests: HttpRequest[] = [];
  constructor(private readonly fixtures: FixtureMap) {}

  async request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req);
    const hit = this.fixtures[`${req.method} ${req.url}`] ?? this.fixtures[`${req.method} ${req.url.split('?')[0]}`];
    if (!hit) return { status: 404, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'no fixture', url: req.url }) };
    return typeof hit === 'function' ? hit(req) : structuredClone(hit);
  }
}

// ---------- discovery (6.14) ----------

export interface DiscoveryQuery {
  founderName: string;
  aliases: string[];
  company: string;
  companyDomain: string;
  handles: string[];
  coauthors: string[];
  since: string;
}

export function discoveryQuery(profile: FounderProfile): DiscoveryQuery {
  return {
    founderName: profile.name,
    aliases: profile.aliases,
    company: profile.company,
    companyDomain: profile.domain,
    handles: [...profile.githubLogins, profile.linkedinId].filter(Boolean),
    coauthors: profile.coauthors ?? [],
    since: profile.scanSince ?? '2023-01-01',
  };
}

export type DiscoveredKind = 'article' | 'podcast_episode' | 'launch' | 'badge' | 'review_assignment' | 'work' | 'model' | 'filing' | 'patent';

/**
 * Normalized meta by kind: review_assignment {role: 'reviewer'|'area_chair', venue, status: 'accepted'|'declined'|'pending'};
 * filing {formType, issuerName, amountSold?, filedAt}; patent {status: 'granted'|'pending', inventors: string[]};
 * badge {badge}; launch {votes?, points?, submitter?}; model {downloads, likes}; work {doi?, venue?}.
 */
export interface DiscoveredItem {
  source: string;
  externalId: string;
  kind: DiscoveredKind;
  url: string;
  title: string;
  text: string;
  publishedAt: string | null;
  author?: { name?: string; domain?: string; handle?: string };
  submittedByFounder?: boolean;
  meta: Record<string, unknown>;
  raw: string;
}

export interface DiscoveryResult {
  items: DiscoveredItem[];
  errors: string[];
  /** A free-tier limit was hit; retry next run (E68). */
  limited?: boolean;
}

export interface DiscoveryAdapter {
  readonly info: IntegrationInfo;
  discover(q: DiscoveryQuery): Promise<DiscoveryResult>;
}

export function toSourceItem(d: DiscoveredItem): SourceItem {
  return {
    app: 'discovery',
    id: `${d.source}:${d.externalId}`,
    date: d.publishedAt,
    title: d.title,
    text: d.text,
    author: d.author ? { name: d.author.name, domain: d.author.domain, handle: d.author.handle } : undefined,
    url: d.url,
    links: [d.url],
    meta: { ...d.meta, discovered: true, source: d.source, kind: d.kind, submittedByFounder: d.submittedByFounder ?? false },
    raw: d.raw,
    rawType: 'json',
  };
}

// ---------- verifier APIs: structured sources first (6.11, 6.14) ----------

export interface ApiCandidate extends ResearchCandidate {
  source_class: 'api';
  /** The raw API response, saved as the snapshot. `sentence` must be an exact substring of it (whitespace collapsed) containing the number. */
  response: string;
}

export interface VerifierRequest {
  exhibit: ExhibitRecord;
  criterion: O1Criterion;
  profile: FounderProfile;
}

export interface VerifierAdapter {
  readonly info: IntegrationInfo;
  figures(req: VerifierRequest): Promise<{ candidates: ApiCandidate[]; errors: string[]; limited?: boolean }>;
}

/** Called by the Corroborator before any web search; a `limited` result defers the exhibit to the next run. */
export interface StructuredResearch {
  readonly kind: string;
  propose(req: ResearchRequest): Promise<{ candidates: ApiCandidate[]; errors: string[]; limited: boolean }>;
}
