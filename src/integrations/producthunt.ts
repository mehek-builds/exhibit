import type { DiscoveredItem, DiscoveryAdapter, DiscoveryQuery, DiscoveryResult, HttpTransport, IntegrationInfo } from './types.js';

// Product Hunt discovery adapter (PRD 6.14, 9 E60). API v2, GraphQL POST with a Bearer developer
// token. Launches map to kind 'launch'; a Product of the Day badge is split into a separate
// 'badge' item (E60: #1 candidate, needs_attorney — discovery.json's N-badge-no-rule) since no
// working rule decides it yet.
//
// UNCONFIRMED: the exact GraphQL schema below (query shape, field names `postsByUser`/`search`,
// `topics`, `votesCount`, `user.username`, badge field name) is written from the public API v2
// docs' general shape and has not been run against a live token. Verify field names against
// https://api.producthunt.com/v2/docs before relying on this in production.

const GRAPHQL_URL = 'https://api.producthunt.com/v2/api/graphql';
const RESULT_CAP = 50;

interface PostNode {
  id: string;
  name: string;
  tagline: string;
  description: string | null;
  url: string;
  website: string | null;
  votesCount: number;
  createdAt: string;
  user: { username: string; name: string } | null;
  // UNCONFIRMED: badge/award field name; PRD only promises "Product of the Day / badge data".
  badges?: { type: string }[] | null;
}

interface GraphQLResponse {
  data?: { posts?: { edges: { node: PostNode }[] } };
  errors?: { message: string }[];
}

export interface ProductHuntAdapterOptions {
  transport: HttpTransport;
  token: string;
  baseUrl?: string;
}

export function createProductHuntAdapter(opts: ProductHuntAdapterOptions): DiscoveryAdapter {
  const url = opts.baseUrl ?? GRAPHQL_URL;

  const info: IntegrationInfo = {
    id: 'producthunt',
    name: 'Product Hunt (API v2)',
    job: ['discover'],
    tier: 2,
    criteria: '#5, #1',
    // PRD 6.14: free developer token; commercial use needs Product Hunt's permission.
    freeTier: "Free developer token for non-commercial use; commercial use needs Product Hunt's permission",
    credentials: ['token'],
    receives: "The founder's public name, company and handles, as search queries",
  };

  async function search(query: string, since: string): Promise<PostNode[]> {
    // UNCONFIRMED: exact query name/args (`search(query, postedAfter)`); Product Hunt's public docs
    // describe a `posts(order, search, postedAfter)` connection more reliably than a generic `search`.
    const body = JSON.stringify({
      query: `query($q: String!, $after: DateTime) {
        posts(query: $q, postedAfter: $after, first: 50) {
          edges { node { id name tagline description url website votesCount createdAt user { username name } badges { type } } }
        }
      }`,
      variables: { q: query, after: since },
    });
    const res = await opts.transport.request({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.token}` },
      body,
    });
    if (res.status === 429) throw new RateLimited();
    if (res.status >= 400) throw new Error(`Product Hunt GraphQL failed: ${res.status}`);
    const parsed = JSON.parse(res.body) as GraphQLResponse;
    if (parsed.errors?.length) {
      // A documented quota/rate-limit error surfaces as a GraphQL error, not just HTTP 429.
      if (parsed.errors.some((e) => /rate|quota|limit/i.test(e.message))) throw new RateLimited();
      throw new Error(parsed.errors.map((e) => e.message).join('; '));
    }
    return parsed.data?.posts?.edges.map((e) => e.node) ?? [];
  }

  return {
    info,
    async discover(q: DiscoveryQuery): Promise<DiscoveryResult> {
      const items: DiscoveredItem[] = [];
      const errors: string[] = [];
      let limited = false;
      const queries = [q.company, q.founderName].filter(Boolean);
      const seen = new Set<string>();

      for (const query of queries) {
        if (items.length >= RESULT_CAP) break;
        try {
          const posts = await search(query, q.since);
          for (const post of posts) {
            if (seen.has(post.id)) continue;
            seen.add(post.id);
            const text = [post.name, post.tagline, post.description ?? ''].filter(Boolean).join('\n');
            if (!text) continue;
            const submittedByFounder = !!post.user && q.handles.some((h) => !!h && h.toLowerCase() === post.user!.username.toLowerCase());
            items.push({
              source: 'producthunt',
              externalId: post.id,
              kind: 'launch',
              url: post.url,
              title: post.name,
              text,
              publishedAt: post.createdAt ? new Date(post.createdAt).toISOString() : null,
              author: post.user ? { name: post.user.name, handle: post.user.username } : undefined,
              submittedByFounder,
              meta: { votes: post.votesCount, submitter: post.user?.username },
              raw: JSON.stringify(post),
            });
            for (const badge of post.badges ?? []) {
              items.push({
                source: 'producthunt',
                externalId: `${post.id}:badge:${badge.type}`,
                kind: 'badge',
                url: post.url,
                title: `${post.name} — ${badge.type}`,
                text: `${post.name}: ${badge.type}\n${text}`,
                publishedAt: post.createdAt ? new Date(post.createdAt).toISOString() : null,
                author: post.user ? { name: post.user.name, handle: post.user.username } : undefined,
                submittedByFounder,
                meta: { badge: badge.type },
                raw: JSON.stringify({ post, badge }),
              });
            }
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
    super('Product Hunt rate limited');
  }
}
