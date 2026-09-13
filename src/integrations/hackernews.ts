import type { DiscoveredItem, DiscoveryAdapter, DiscoveryQuery, DiscoveryResult, HttpTransport, IntegrationInfo } from './types.js';

// Hacker News discovery adapter (PRD 6.14, 9 E59). Algolia search API, free, no key. Finds Show HN
// launches and front-page mentions of the founder or company. Self-submitted posts are marked
// `submittedByFounder` (E59): discovery.json's X-self-submitted-launch keeps them out of #3 press.

const SEARCH_URL = 'https://hn.algolia.com/api/v1/search';
const HITS_PER_PAGE = 50;
const RESULT_CAP = 50;

interface AlgoliaHit {
  objectID: string;
  title: string | null;
  story_text: string | null;
  comment_text: string | null;
  url: string | null;
  author: string;
  points: number | null;
  num_comments: number | null;
  created_at: string;
}

interface AlgoliaResponse {
  hits: AlgoliaHit[];
}

export interface HackerNewsAdapterOptions {
  transport: HttpTransport;
  baseUrl?: string;
}

export function createHackerNewsAdapter(opts: HackerNewsAdapterOptions): DiscoveryAdapter {
  const base = opts.baseUrl ?? SEARCH_URL;
  const { transport } = opts;

  const info: IntegrationInfo = {
    id: 'hackernews',
    name: 'Hacker News (Algolia search API)',
    job: ['discover'],
    tier: 2,
    criteria: '#5',
    freeTier: 'Free, no key',
    credentials: [],
    receives: "The founder's public name, company and handles, as search queries",
  };

  return {
    info,
    async discover(q: DiscoveryQuery): Promise<DiscoveryResult> {
      const items: DiscoveredItem[] = [];
      const errors: string[] = [];
      let limited = false;
      const queries = [q.founderName, q.company, ...q.aliases].filter(Boolean);
      const seen = new Set<string>();
      const sinceEpoch = Math.floor(new Date(q.since).getTime() / 1000);

      for (const query of queries) {
        if (items.length >= RESULT_CAP) break;
        const url = `${base}?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${HITS_PER_PAGE}&numericFilters=created_at_i%3E${sinceEpoch}`;
        const res = await transport.request({ method: 'GET', url });
        if (res.status === 429) {
          limited = true;
          continue;
        }
        if (res.status >= 400) {
          errors.push(`Algolia HN search failed: ${res.status}`);
          continue;
        }
        let parsed: AlgoliaResponse;
        try {
          parsed = JSON.parse(res.body) as AlgoliaResponse;
        } catch {
          errors.push('Algolia HN search returned invalid JSON');
          continue;
        }
        for (const hit of parsed.hits ?? []) {
          if (seen.has(hit.objectID)) continue;
          seen.add(hit.objectID);
          const title = hit.title ?? '';
          const text = [title, hit.story_text ?? '', hit.comment_text ?? ''].filter(Boolean).join('\n');
          if (!text) continue;
          const isShowHn = /^show hn:/i.test(title);
          const submittedByFounder = q.handles.some((h) => !!h && h.toLowerCase() === hit.author.toLowerCase());
          const itemUrl = hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`;
          items.push({
            source: 'hackernews',
            externalId: hit.objectID,
            kind: isShowHn || submittedByFounder ? 'launch' : 'article',
            url: itemUrl,
            title,
            text,
            publishedAt: hit.created_at ? new Date(hit.created_at).toISOString() : null,
            author: { name: hit.author, handle: hit.author },
            submittedByFounder,
            meta: { points: hit.points ?? 0, num_comments: hit.num_comments ?? 0, submitter: hit.author },
            raw: JSON.stringify(hit),
          });
          if (items.length >= RESULT_CAP) break;
        }
      }
      return { items: items.slice(0, RESULT_CAP), errors, limited };
    },
  };
}
