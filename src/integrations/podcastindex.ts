import { createHash } from 'node:crypto';
import type { DiscoveredItem, DiscoveryAdapter, DiscoveryQuery, DiscoveryResult, HttpTransport, IntegrationInfo } from './types.js';

// Podcast Index discovery adapter (PRD 6.14). `/search/byperson`, signed with X-Auth-Key /
// X-Auth-Date / Authorization = sha1(key + secret + unix-date) hex, per the Podcast Index API docs.
//
// UNCONFIRMED: the exact response field names below (`episodes[].feedTitle`, `.episodeUrl`,
// `.datePublished`) follow the documented /search/byperson shape but have not been checked against
// a live key; verify against https://podcastindex-org.github.io/docs-api/ before relying on them.

const SEARCH_URL = 'https://api.podcastindex.org/api/1.0/search/byperson';
const RESULT_CAP = 50;
const USER_AGENT = 'Exhibit/0.1 (evidence agent)';

interface Episode {
  id: number;
  title: string;
  description: string | null;
  link: string | null;
  enclosureUrl: string | null;
  feedTitle: string;
  feedUrl: string;
  datePublished: number; // unix seconds
  feedImage?: string;
}

interface PodcastIndexResponse {
  status: string;
  items: Episode[];
}

export interface PodcastIndexAdapterOptions {
  transport: HttpTransport;
  apiKey: string;
  apiSecret: string;
  baseUrl?: string;
  /** Injectable for tests; defaults to the current time. */
  now?: () => number;
}

function authHeaders(apiKey: string, apiSecret: string, nowSeconds: number): Record<string, string> {
  const authDate = String(nowSeconds);
  const authorization = createHash('sha1').update(apiKey + apiSecret + authDate).digest('hex');
  return {
    'X-Auth-Key': apiKey,
    'X-Auth-Date': authDate,
    Authorization: authorization,
    'User-Agent': USER_AGENT,
  };
}

export function createPodcastIndexAdapter(opts: PodcastIndexAdapterOptions): DiscoveryAdapter {
  const base = opts.baseUrl ?? SEARCH_URL;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));

  const info: IntegrationInfo = {
    id: 'podcastindex',
    name: 'Podcast Index',
    job: ['discover'],
    tier: 2,
    criteria: '#3',
    freeTier: 'Free API key',
    credentials: ['apiKey', 'apiSecret (signed request headers)'],
    receives: "The founder's public name, company and handles, as search queries",
  };

  async function search(query: string): Promise<Episode[]> {
    const url = `${base}?q=${encodeURIComponent(query)}`;
    const res = await opts.transport.request({ method: 'GET', url, headers: authHeaders(opts.apiKey, opts.apiSecret, now()) });
    if (res.status === 429) throw new RateLimited();
    if (res.status >= 400) throw new Error(`Podcast Index search failed: ${res.status}`);
    const parsed = JSON.parse(res.body) as PodcastIndexResponse;
    if (parsed.status && parsed.status !== 'true') throw new Error(`Podcast Index error status: ${parsed.status}`);
    return parsed.items ?? [];
  }

  return {
    info,
    async discover(q: DiscoveryQuery): Promise<DiscoveryResult> {
      const items: DiscoveredItem[] = [];
      const errors: string[] = [];
      let limited = false;
      const queries = [q.founderName, ...q.aliases].filter(Boolean);
      const seen = new Set<number>();
      const sinceEpoch = Math.floor(new Date(q.since).getTime() / 1000);

      for (const query of queries) {
        if (items.length >= RESULT_CAP) break;
        try {
          const episodes = await search(query);
          for (const ep of episodes) {
            if (seen.has(ep.id)) continue;
            seen.add(ep.id);
            if (ep.datePublished < sinceEpoch) continue;
            const text = [ep.title, ep.feedTitle, ep.description ?? ''].filter(Boolean).join('\n');
            if (!text) continue;
            items.push({
              source: 'podcastindex',
              externalId: String(ep.id),
              kind: 'podcast_episode',
              url: ep.link ?? ep.enclosureUrl ?? ep.feedUrl,
              title: ep.title,
              text,
              publishedAt: new Date(ep.datePublished * 1000).toISOString(),
              author: { name: ep.feedTitle },
              meta: {
                show: ep.feedTitle,
                episode: ep.title,
                feedUrl: ep.feedUrl,
                episodeUrl: ep.link ?? ep.enclosureUrl ?? null,
              },
              raw: JSON.stringify(ep),
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
      }
      return { items: items.slice(0, RESULT_CAP), errors, limited };
    },
  };
}

class RateLimited extends Error {
  constructor() {
    super('Podcast Index rate limited');
  }
}
