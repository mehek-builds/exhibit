import type { ApiCandidate, HttpTransport, IntegrationInfo, VerifierAdapter, VerifierRequest } from './types.js';

// O*NET Web Services verifier adapter (PRD 6.11, 6.14, 8 C12/C14). Official record-keeper for the
// occupation's wage data, so it counts as primary/record-keeper alongside BLS
// (src/integrations/bls.ts) for the #8 90th-percentile benchmark. Free with registration. Maps
// profile.jobTitle to an occupation code via O*NET's search endpoint when profile.socCode is
// absent, then reads that occupation's wage summary.
//
// CONFIRMED (https://services.onetcenter.org/reference/start/overview,
// https://services.onetcenter.org/reference/online/occupation): O*NET Web Services v2 is on a
// separate host, `api-v2.onetcenter.org` (not `services.onetcenter.org`), under the `/online/...`
// path (not `/ws/online`) — the docs' own worked example is
// `https://api-v2.onetcenter.org/online/occupations/17-2051.00/`. Authentication is a single
// `X-API-Key` request header ("All requests must be accompanied by an X-API-Key header"), not
// HTTP Basic with a username/key pair.
//
// STILL UNCONFIRMED: the exact JSON field name/path for the 90th-percentile annual wage inside
// /occupations/<code>/summary/wages — the public reference pages reachable from
// https://services.onetcenter.org/reference/online/occupation describe the occupation summary
// report's sections (tasks, skills, related occupations, etc.) but the wages sub-endpoint's field
// schema was not fetchable from those pages. This adapter keeps reading `annual_wages.percentile_90`
// as a placeholder; verify the real shape (candidates seen in search results, unconfirmed against
// primary docs: flat fields like `annual_90th_percentile`) against
// https://services.onetcenter.org/reference/online/occupation/summary_report or the OpenAPI
// description linked from https://services.onetcenter.org/reference/start/overview#openapi before
// relying on this in production.

interface OnetSearchResult {
  occupation?: { code: string }[];
}

interface OnetWages {
  annual_wages?: { percentile_90?: number };
}

export interface OnetAdapterOptions {
  transport: HttpTransport;
  /** X-API-Key value (confirmed auth scheme; see module comment). */
  key: string;
  /**
   * @deprecated unused — v2 auth is a single X-API-Key (`key`), not a username/key Basic-auth
   * pair. Kept optional so existing callers (harness/presets.ts, src/config.ts — not owned by
   * this change) keep compiling; wire them to drop it in a follow-up.
   */
  username?: string;
  baseUrl?: string;
}

function authHeader(key: string): Record<string, string> {
  return { 'x-api-key': key };
}

/** O*NET SOC codes carry a detail suffix (e.g. "11-1011.00"); a bare BLS-style SOC ("11-1011")
 *  gets ".00" appended. UNCONFIRMED: whether every BLS SOC maps 1:1 to O*NET's default ".00" leaf. */
function normalizeOnetCode(soc: string): string {
  return /\.\d+$/.test(soc) ? soc : `${soc}.00`;
}

export function createOnetAdapter(opts: OnetAdapterOptions): VerifierAdapter {
  const base = opts.baseUrl ?? 'https://api-v2.onetcenter.org/online';
  const info: IntegrationInfo = {
    id: 'onet',
    name: 'O*NET Web Services',
    job: ['verify'],
    tier: 1,
    criteria: '#8',
    freeTier: 'Free with registration',
    credentials: ['API key (X-API-Key header)'],
    receives: 'A job title and occupation code',
  };

  return {
    info,
    async figures(req: VerifierRequest) {
      if (req.criterion !== 8) return { candidates: [], errors: [] };
      const auth = authHeader(opts.key);
      let code = req.profile.socCode ? normalizeOnetCode(req.profile.socCode) : null;
      if (!code) {
        if (!req.profile.jobTitle) return { candidates: [], errors: [] };
        const searchUrl = `${base}/search?keyword=${encodeURIComponent(req.profile.jobTitle)}`;
        const searchRes = await opts.transport.request({ method: 'GET', url: searchUrl, headers: auth });
        if (searchRes.status === 429) return { candidates: [], errors: [], limited: true };
        if (searchRes.status >= 400) return { candidates: [], errors: [`O*NET search failed: ${searchRes.status}`] };
        let parsed: OnetSearchResult;
        try {
          parsed = JSON.parse(searchRes.body) as OnetSearchResult;
        } catch {
          return { candidates: [], errors: ['O*NET search response was not valid JSON'] };
        }
        code = parsed.occupation?.[0]?.code ?? null;
        if (!code) return { candidates: [], errors: [`O*NET search returned no occupation for "${req.profile.jobTitle}"`] };
      }
      const url = `${base}/occupations/${encodeURIComponent(code)}/summary/wages`;
      const res = await opts.transport.request({ method: 'GET', url, headers: auth });
      if (res.status === 429) return { candidates: [], errors: [], limited: true };
      if (res.status >= 400) return { candidates: [], errors: [`O*NET wages fetch failed: ${res.status}`] };
      let wages: OnetWages;
      try {
        wages = JSON.parse(res.body) as OnetWages;
      } catch {
        return { candidates: [], errors: ['O*NET wages response was not valid JSON'] };
      }
      const p90 = wages.annual_wages?.percentile_90;
      if (p90 === undefined) return { candidates: [], errors: [`O*NET wages response missing annual_wages.percentile_90 for ${code}`] };
      const sentenceMatch = new RegExp(`"percentile_90"\\s*:\\s*${p90}\\b`).exec(res.body);
      if (!sentenceMatch) return { candidates: [], errors: ['O*NET response did not contain percentile_90 as expected'] };
      const candidate: ApiCandidate = {
        source_class: 'api',
        measure: '90th-percentile annual wage',
        value: p90,
        unit: 'USD per year',
        sentence: sentenceMatch[0].replace(/\s+/g, ' '),
        url,
        publisher: 'O*NET Web Services',
        // BLS (src/integrations/bls.ts) is the primary record-keeper for #8; O*NET serves as the
        // second/verifying source here so the pair reaches `independently_confirmed`.
        kind: 'verifier',
        as_of: new Date().toISOString(),
        response: res.body,
      };
      return { candidates: [candidate], errors: [] };
    },
  };
}
