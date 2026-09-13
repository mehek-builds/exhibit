import type { DiscoveredItem, DiscoveryAdapter, DiscoveryQuery, DiscoveryResult, HttpTransport, IntegrationInfo } from './types.js';

// GDELT DOC 2.0 API discovery adapter (PRD 6.14). Free, no key. Searches recent worldwide news for
// the founder's name and company; each hit is a candidate article for the second-identifier rule and
// the verifier -- it becomes #3 (C3-press-about) once the classifier and mapper accept it (6.14, E58).

const BASE_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';
const MAX_RECORDS = 75;

interface GdeltArticle {
  url: string;
  url_mobile?: string;
  title: string;
  seendate: string; // e.g. "20260318T140000Z"
  domain: string;
  language?: string;
  sourcecountry?: string;
  socialimage?: string;
}

interface GdeltResponse {
  articles?: GdeltArticle[];
}

function gdeltDateToIso(seendate: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(seendate);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
}

function sinceToGdelt(since: string): string {
  // GDELT wants startdatetime as YYYYMMDDHHMMSS.
  const d = new Date(since);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

export interface GdeltAdapterOptions {
  transport: HttpTransport;
  baseUrl?: string;
}

export function createGdeltAdapter(opts: GdeltAdapterOptions): DiscoveryAdapter {
  const base = opts.baseUrl ?? BASE_URL;
  const { transport } = opts;

  const info: IntegrationInfo = {
    id: 'gdelt',
    name: 'GDELT (DOC 2.0 API)',
    job: ['discover'],
    tier: 1,
    criteria: '#3',
    freeTier: 'Free, no key',
    credentials: [],
    receives: "The founder's public name and company, as search queries",
  };

  function toItem(a: GdeltArticle): DiscoveredItem {
    const publishedAt = gdeltDateToIso(a.seendate);
    // Only what the source returned: the second-identifier rule (constraint 16) must read the outlet's
    // own words, so Exhibit never writes the founder's name into the item itself.
    const text = `Article: ${a.title}\nOutlet: ${a.domain}`;
    return {
      source: 'gdelt',
      externalId: a.url,
      kind: 'article',
      url: a.url,
      title: a.title,
      text,
      publishedAt,
      author: { domain: a.domain },
      meta: {},
      raw: JSON.stringify(a),
    };
  }

  return {
    info,
    async discover(q: DiscoveryQuery): Promise<DiscoveryResult> {
      const items: DiscoveredItem[] = [];
      const errors: string[] = [];
      let limited = false;
      const seen = new Set<string>();

      const query = `"${q.founderName}" "${q.company}"`;
      const url = `${base}?query=${encodeURIComponent(query)}&mode=artlist&format=json&maxrecords=${MAX_RECORDS}&startdatetime=${sinceToGdelt(q.since)}`;
      try {
        const res = await transport.request({ method: 'GET', url });
        if (res.status === 429) {
          limited = true;
        } else if (res.status >= 400) {
          errors.push(`GDELT DOC search failed: ${res.status}`);
        } else {
          const parsed = JSON.parse(res.body) as GdeltResponse;
          for (const a of parsed.articles ?? []) {
            if (!a.url || seen.has(a.url)) continue;
            seen.add(a.url);
            items.push(toItem(a));
          }
        }
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }

      return { items, errors, limited };
    },
  };
}
