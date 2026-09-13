import type { ApiCandidate, HttpTransport, IntegrationInfo, VerifierAdapter, VerifierRequest } from './types.js';

// Crossref verifier adapter (PRD 6.11, 6.14). DOI metadata and citation counts (#6), free with a
// polite-pool contact email. Structured source, queried before web search.

const DOI_RE = /doi\.org\/(.+)$/i;

function findDoi(req: VerifierRequest): string | null {
  for (const s of req.exhibit.sources) {
    const m = s.url ? DOI_RE.exec(s.url) : null;
    if (m) return decodeURIComponent(m[1]!);
  }
  const meta = req.exhibit.metrics as Record<string, unknown>;
  return typeof meta.doi === 'string' ? meta.doi : null;
}

interface CrossrefWork {
  'is-referenced-by-count': number;
  publisher?: string;
  deposited?: { 'date-time'?: string };
}

interface CrossrefResponse {
  message: CrossrefWork;
}

export interface CrossrefAdapterOptions {
  transport: HttpTransport;
  mailto: string;
  baseUrl?: string;
}

export function createCrossrefAdapter(opts: CrossrefAdapterOptions): VerifierAdapter {
  const base = opts.baseUrl ?? 'https://api.crossref.org';
  const info: IntegrationInfo = {
    id: 'crossref',
    name: 'Crossref',
    job: ['verify'],
    tier: 2,
    criteria: '#6',
    freeTier: 'Free (polite pool with a contact email)',
    credentials: [],
    receives: "The founder's public name, company and handles, as search queries",
  };

  return {
    info,
    async figures(req: VerifierRequest) {
      const doi = findDoi(req);
      if (!doi) return { candidates: [], errors: [] };
      const url = `${base}/works/${encodeURIComponent(doi)}?mailto=${encodeURIComponent(opts.mailto)}`;
      const res = await opts.transport.request({ method: 'GET', url });
      if (res.status === 429) return { candidates: [], errors: [], limited: true };
      if (res.status >= 400) return { candidates: [], errors: [`Crossref fetch failed: ${res.status}`] };
      let parsed: CrossrefResponse;
      try {
        parsed = JSON.parse(res.body) as CrossrefResponse;
      } catch {
        return { candidates: [], errors: ['Crossref response was not valid JSON'] };
      }
      const count = parsed.message?.['is-referenced-by-count'];
      if (count === undefined) return { candidates: [], errors: ['Crossref response missing is-referenced-by-count'] };
      const sentenceMatch = new RegExp(`"is-referenced-by-count"\\s*:\\s*${count}\\b`).exec(res.body);
      if (!sentenceMatch) return { candidates: [], errors: ['Crossref response did not contain is-referenced-by-count as expected'] };
      const candidate: ApiCandidate = {
        source_class: 'api',
        measure: 'citations',
        value: count,
        unit: 'citations',
        sentence: sentenceMatch[0].replace(/\s+/g, ' '),
        url,
        publisher: 'Crossref',
        kind: 'verifier',
        as_of: parsed.message.deposited?.['date-time'] ?? new Date().toISOString(),
        response: res.body,
      };
      return { candidates: [candidate], errors: [] };
    },
  };
}
