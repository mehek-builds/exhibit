import type { ApiCandidate, HttpTransport, IntegrationInfo, VerifierAdapter, VerifierRequest } from './types.js';

// OpenAlex verifier adapter (PRD 6.11, 6.14). Structured source for journal/venue statistics and
// citation counts (#6, #5): queried before any web search. Free tier: a key with $1/day usage
// (about 1,000 searches or 10,000 list calls) — a 429 here means that daily allowance is spent and
// the figure must be queued for the next day (E68), never filled from web search instead.
//
// CHECKED (not adding 409): OpenAlex's own error-code table
// (https://help.openalex.org/api/errors/) documents only `429` — "Too Many Requests — Rate limit
// or daily credit budget exceeded" — as the quota-exhausted signal; there is no documented `409`
// case there. Community reports of a `409` (e.g. missing/invalid `api_key` after OpenAlex made
// keys mandatory) describe an auth error, not the daily-quota-exhausted case this adapter already
// always sends `api_key`/`mailto` for, so `409` is intentionally left untreated as `limited` here.

const DOI_RE = /doi\.org\/(.+)$/i;

function findDoi(req: VerifierRequest): string | null {
  for (const s of req.exhibit.sources) {
    const m = s.url ? DOI_RE.exec(s.url) : null;
    if (m) return decodeURIComponent(m[1]!);
  }
  const meta = req.exhibit.metrics as Record<string, unknown>;
  return typeof meta.doi === 'string' ? meta.doi : null;
}

interface OpenAlexWork {
  cited_by_count: number;
  doi?: string;
  host_venue?: { display_name?: string };
  updated_date?: string;
}

export interface OpenAlexAdapterOptions {
  transport: HttpTransport;
  apiKey?: string;
  mailto: string;
  baseUrl?: string;
}

export function createOpenAlexAdapter(opts: OpenAlexAdapterOptions): VerifierAdapter {
  const base = opts.baseUrl ?? 'https://api.openalex.org';
  const info: IntegrationInfo = {
    id: 'openalex',
    name: 'OpenAlex',
    job: ['verify'],
    tier: 1,
    criteria: '#5, #6',
    freeTier: 'Free key with $1 of usage a day (about 1,000 searches or 10,000 list calls)',
    credentials: ['Key'],
    receives: "The founder's public name, company and handles, as search queries",
  };

  return {
    info,
    async figures(req: VerifierRequest) {
      const doi = findDoi(req);
      if (!doi) return { candidates: [], errors: [] };
      const params = new URLSearchParams({ mailto: opts.mailto });
      if (opts.apiKey) params.set('api_key', opts.apiKey);
      const url = `${base}/works/doi:${encodeURIComponent(doi)}?${params.toString()}`;
      const res = await opts.transport.request({ method: 'GET', url });
      if (res.status === 429) return { candidates: [], errors: [], limited: true };
      if (res.status >= 400) return { candidates: [], errors: [`OpenAlex fetch failed: ${res.status}`] };
      let work: OpenAlexWork;
      try {
        work = JSON.parse(res.body) as OpenAlexWork;
      } catch {
        return { candidates: [], errors: ['OpenAlex response was not valid JSON'] };
      }
      const sentenceMatch = new RegExp(`"cited_by_count"\\s*:\\s*${work.cited_by_count}\\b`).exec(res.body);
      if (!sentenceMatch) return { candidates: [], errors: ['OpenAlex response did not contain cited_by_count as expected'] };
      const candidate: ApiCandidate = {
        source_class: 'api',
        measure: 'citations',
        value: work.cited_by_count,
        unit: 'citations',
        sentence: sentenceMatch[0].replace(/\s+/g, ' '),
        url,
        publisher: 'OpenAlex',
        kind: 'verifier',
        as_of: work.updated_date ?? new Date().toISOString(),
        response: res.body,
      };
      return { candidates: [candidate], errors: [] };
    },
  };
}
