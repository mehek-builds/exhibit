import type { DiscoveredItem, DiscoveryAdapter, DiscoveryQuery, DiscoveryResult, HttpTransport, IntegrationInfo } from './types.js';

// USPTO PatentSearch discovery adapter (PRD 6.14). PatentsView API v1, `X-Api-Key` header, query on
// inventor name. Kind 'patent' for granted patents; applications are queried too when available.
//
// Inventor filters use dotted sub-fields against the `inventors` object array, not a single
// combined-name field — the query previously sent a whole "First Last" string to a top-level
// `inventors_at_grant` field, which is not how PatentsView's structured search works (docs review,
// 2026-09-13). This adapter now filters on `inventors.inventor_name_last` and
// `inventors.inventor_name_first` separately, matching the shape of the `inventors[]` objects
// PatentsView already returns in responses.
//
// UNCONFIRMED against https://search.patentsview.org/docs/docs/Search%20API/EndpointDictionary/ —
// verify before relying on this in production: whether the correct v1 field name is
// `inventors.inventor_name_last` (used here) or `inventors_at_grant.name_last` (the sibling
// endpoint/entity some PatentsView docs use for as-granted inventor records). Both spellings
// appear across PatentsView's docs depending on API version; only one has been implemented, and
// switching requires updating both the query fields below and the response field names read in
// `search()` (`inventors[].inventor_name_first/last` vs `inventors_at_grant[].name_first/last`) so
// the two stay consistent. The pre-grant-applications endpoint is separately UNCONFIRMED to exist
// under the same PatentsView v1 API — check whether a separate `/api/v1/patent/application/` path
// is documented before shipping.

const PATENT_URL = 'https://search.patentsview.org/api/v1/patent/';
const RESULT_CAP = 50;

interface Inventor {
  inventor_name_first?: string;
  inventor_name_last?: string;
}

interface Assignee {
  assignee_organization?: string;
}

interface PatentRecord {
  patent_id: string;
  patent_title: string;
  patent_abstract: string | null;
  patent_date: string; // YYYY-MM-DD
  inventors: Inventor[];
  assignees?: Assignee[];
}

interface PatentsViewResponse {
  error?: boolean;
  patents?: PatentRecord[];
  count?: number;
}

export interface UsptoAdapterOptions {
  transport: HttpTransport;
  apiKey: string;
  baseUrl?: string;
}

export function createUsptoAdapter(opts: UsptoAdapterOptions): DiscoveryAdapter {
  const base = opts.baseUrl ?? PATENT_URL;

  const info: IntegrationInfo = {
    id: 'uspto',
    name: 'USPTO PatentSearch',
    job: ['discover'],
    tier: 2,
    criteria: '#5',
    freeTier: 'Free key',
    credentials: ['apiKey'],
    receives: "The founder's public name, company and handles, as search queries",
  };

  function inventorName(founderName: string): { first: string; last: string } {
    const parts = founderName.trim().split(/\s+/);
    return { first: parts[0] ?? founderName, last: parts[parts.length - 1] ?? founderName };
  }

  async function search(founderName: string, since: string): Promise<PatentRecord[]> {
    const { first, last } = inventorName(founderName);
    const query = {
      _and: [
        { _text_any: { 'inventors.inventor_name_last': last } },
        { _text_any: { 'inventors.inventor_name_first': first } },
        { _gte: { patent_date: since.slice(0, 10) } },
      ],
    };
    const fields = ['patent_id', 'patent_title', 'patent_abstract', 'patent_date', 'inventors', 'assignees'];
    const url = `${base}?q=${encodeURIComponent(JSON.stringify(query))}&f=${encodeURIComponent(JSON.stringify(fields))}`;
    const res = await opts.transport.request({ method: 'GET', url, headers: { 'X-Api-Key': opts.apiKey } });
    if (res.status === 429) throw new RateLimited();
    if (res.status >= 400) throw new Error(`USPTO PatentSearch failed: ${res.status}`);
    const parsed = JSON.parse(res.body) as PatentsViewResponse;
    if (parsed.error) throw new Error('USPTO PatentSearch returned an error response');
    return parsed.patents ?? [];
  }

  return {
    info,
    async discover(q: DiscoveryQuery): Promise<DiscoveryResult> {
      const items: DiscoveredItem[] = [];
      const errors: string[] = [];
      let limited = false;
      const seen = new Set<string>();

      try {
        const patents = await search(q.founderName, q.since);
        for (const p of patents) {
          if (seen.has(p.patent_id)) continue;
          seen.add(p.patent_id);
          const inventorNames = p.inventors.map((i) => [i.inventor_name_first, i.inventor_name_last].filter(Boolean).join(' ')).filter(Boolean);
          const assigneeNames = (p.assignees ?? []).map((a) => a.assignee_organization).filter((n): n is string => !!n);
          const text = [p.patent_title, `Inventors: ${inventorNames.join(', ')}`, assigneeNames.length ? `Assignee: ${assigneeNames.join(', ')}` : '', p.patent_abstract ?? '']
            .filter(Boolean)
            .join('\n');
          if (!text) continue;
          items.push({
            source: 'uspto',
            externalId: p.patent_id,
            kind: 'patent',
            url: `https://patents.google.com/patent/US${p.patent_id}`,
            title: p.patent_title,
            text,
            publishedAt: p.patent_date ? new Date(p.patent_date).toISOString() : null,
            author: undefined,
            meta: { status: 'granted' as const, inventors: inventorNames, patent_number: p.patent_id, assignees: assigneeNames },
            raw: JSON.stringify(p),
          });
          if (items.length >= RESULT_CAP) break;
        }
      } catch (err) {
        if (err instanceof RateLimited) {
          limited = true;
        } else {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }

      // Pending applications: UNCONFIRMED endpoint (see header comment). Not queried here; if
      // PatentsView documents a `/api/v1/patent/application/` (or similar) path, add a second
      // `search`-like call here producing meta.status = 'pending'.

      return { items: items.slice(0, RESULT_CAP), errors, limited };
    },
  };
}

class RateLimited extends Error {
  constructor() {
    super('USPTO PatentSearch rate limited');
  }
}
