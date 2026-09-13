import type { ApiCandidate, HttpTransport, IntegrationInfo, VerifierAdapter, VerifierRequest } from './types.js';

// Semantic Scholar verifier adapter (PRD 6.11, 6.14). Citations and influential citations (#5,
// #6); free, an optional key raises the rate limit. Structured source, queried before web search.
//
// CONFIRMED rate limits (https://www.semanticscholar.org/product/api, "API Key" section):
// unauthenticated (unkeyed) requests share a 1000-requests-per-second pool across all such
// callers (and may be throttled further at peak load); a request carrying an API key gets its own
// "introductory" limit of 1 request per second on every endpoint.

const DOI_RE = /doi\.org\/(.+)$/i;

function findDoi(req: VerifierRequest): string | null {
  for (const s of req.exhibit.sources) {
    const m = s.url ? DOI_RE.exec(s.url) : null;
    if (m) return decodeURIComponent(m[1]!);
  }
  const meta = req.exhibit.metrics as Record<string, unknown>;
  return typeof meta.doi === 'string' ? meta.doi : null;
}

interface S2Paper {
  citationCount: number;
  influentialCitationCount?: number;
}

export interface SemanticScholarAdapterOptions {
  transport: HttpTransport;
  apiKey?: string;
  baseUrl?: string;
}

export function createSemanticScholarAdapter(opts: SemanticScholarAdapterOptions): VerifierAdapter {
  const base = opts.baseUrl ?? 'https://api.semanticscholar.org/graph/v1';
  const info: IntegrationInfo = {
    id: 'semanticscholar',
    name: 'Semantic Scholar',
    job: ['verify'],
    tier: 2,
    criteria: '#5, #6',
    freeTier: 'Free; unkeyed requests share 1000 req/s across all callers, a key gets its own 1 req/s',
    credentials: ['Optional key'],
    receives: "The founder's public name, company and handles, as search queries",
  };

  return {
    info,
    async figures(req: VerifierRequest) {
      const doi = findDoi(req);
      if (!doi) return { candidates: [], errors: [] };
      const url = `${base}/paper/DOI:${encodeURIComponent(doi)}?fields=citationCount,influentialCitationCount`;
      const headers: Record<string, string> = opts.apiKey ? { 'x-api-key': opts.apiKey } : {};
      const res = await opts.transport.request({ method: 'GET', url, headers });
      if (res.status === 429) return { candidates: [], errors: [], limited: true };
      if (res.status >= 400) return { candidates: [], errors: [`Semantic Scholar fetch failed: ${res.status}`] };
      let parsed: S2Paper;
      try {
        parsed = JSON.parse(res.body) as S2Paper;
      } catch {
        return { candidates: [], errors: ['Semantic Scholar response was not valid JSON'] };
      }
      if (parsed.citationCount === undefined) return { candidates: [], errors: ['Semantic Scholar response missing citationCount'] };
      const sentenceMatch = new RegExp(`"citationCount"\\s*:\\s*${parsed.citationCount}\\b`).exec(res.body);
      if (!sentenceMatch) return { candidates: [], errors: ['Semantic Scholar response did not contain citationCount as expected'] };
      const candidate: ApiCandidate = {
        source_class: 'api',
        measure: 'citations',
        value: parsed.citationCount,
        unit: 'citations',
        sentence: sentenceMatch[0].replace(/\s+/g, ' '),
        url,
        publisher: 'Semantic Scholar',
        kind: 'verifier',
        as_of: new Date().toISOString(),
        response: res.body,
      };
      return { candidates: [candidate], errors: [] };
    },
  };
}
