import type { ApiCandidate, HttpTransport, IntegrationInfo, VerifierAdapter, VerifierRequest } from './types.js';

// BLS Public Data API verifier adapter (PRD 6.11, 6.14, 8 C12/C14). Official record-keeper for
// wages, so BLS counts as the *primary* source for the #8 90th-percentile benchmark
// (prompts/fragments/source-lists.json `record_keepers`), with O*NET (src/integrations/onet.ts) as
// the second source. Free registration key; a daily-query 429 defers the figure (E68).
//
// CONFIRMED: BLS OEWS series ids are `OE` + seasonal(U) + area-type(N=national) +
// area_code(7) + industry_code(6) + occupation_code(6) + datatype_code(2)
// (https://download.bls.gov/pub/time.series/oe/oe.txt — series-id layout and the
// `OEUM0000400000000000001` worked example; national/all-industry aggregates use area 0000000
// and industry 000000). The two-digit datatype code table
// (https://download.bls.gov/pub/time.series/oe/oe.datatype) lists `13` as the *annual median*
// wage and `15` as the *annual 90th-percentile* wage — this adapter needs the 90th percentile, so
// the series must end in `15`, not `13`.
function seriesIdForSoc(socCode: string): string {
  const occ = socCode.replace(/[^0-9]/g, '').padEnd(6, '0').slice(0, 6);
  // area(7) + industry(6) + occupation(6) + datatype(2) = 15 (annual 90th-percentile wage).
  return `OEUN${'0'.repeat(7)}${'0'.repeat(6)}${occ}15`;
}

interface BlsSeriesDatum {
  year: string;
  period: string;
  value: string;
}

interface BlsResponse {
  status: string;
  Results?: { series: { seriesID: string; data: BlsSeriesDatum[] }[] };
}

export interface BlsAdapterOptions {
  transport: HttpTransport;
  registrationKey: string;
  baseUrl?: string;
}

export function createBlsAdapter(opts: BlsAdapterOptions): VerifierAdapter {
  const url = opts.baseUrl ?? 'https://api.bls.gov/publicAPI/v2/timeseries/data/';
  const info: IntegrationInfo = {
    id: 'bls',
    name: 'BLS Public Data API',
    job: ['verify'],
    tier: 1,
    criteria: '#8',
    freeTier: 'Free registration key',
    credentials: ['Key'],
    receives: 'A job title and occupation code',
  };

  return {
    info,
    async figures(req: VerifierRequest) {
      const soc = req.profile.socCode;
      if (req.criterion !== 8 || !soc) return { candidates: [], errors: [] };
      const seriesId = seriesIdForSoc(soc);
      const res = await opts.transport.request({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seriesid: [seriesId], registrationkey: opts.registrationKey }),
      });
      if (res.status === 429) return { candidates: [], errors: [], limited: true };
      if (res.status >= 400) return { candidates: [], errors: [`BLS fetch failed: ${res.status}`] };
      let parsed: BlsResponse;
      try {
        parsed = JSON.parse(res.body) as BlsResponse;
      } catch {
        return { candidates: [], errors: ['BLS response was not valid JSON'] };
      }
      if (parsed.status === 'REQUEST_NOT_PROCESSED') return { candidates: [], errors: [], limited: true };
      const datum = parsed.Results?.series?.[0]?.data?.[0];
      if (!datum) return { candidates: [], errors: [`BLS returned no data for series ${seriesId} (SOC ${soc})`] };
      const value = Number(datum.value.replace(/,/g, ''));
      const sentenceMatch = new RegExp(`"value"\\s*:\\s*"${datum.value}"`).exec(res.body);
      if (!sentenceMatch) return { candidates: [], errors: ['BLS response did not contain the value field as expected'] };
      const candidate: ApiCandidate = {
        source_class: 'api',
        measure: '90th-percentile annual wage',
        value,
        unit: 'USD per year',
        sentence: sentenceMatch[0].replace(/\s+/g, ' '),
        url,
        publisher: 'U.S. Bureau of Labor Statistics (OEWS)',
        kind: 'primary',
        as_of: `${datum.year}-01-01`,
        response: res.body,
      };
      return { candidates: [candidate], errors: [] };
    },
  };
}
