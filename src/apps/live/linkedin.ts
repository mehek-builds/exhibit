import { AppUnavailableError } from '../types.js';
import type { LinkedinApi, LinkedinPost } from '../types.js';

// LinkedIn has no public API for mentions (PRD 6.1, 7.5): the Arga LinkedIn twin is the only
// surface during the event. Without a `baseUrl` this returns null, and the agent records
// linkedin as degraded (PRD 10) rather than guessing at endpoint shapes.
//
// UNCONFIRMED (PRD 7.1): the twin's exact endpoint paths and response shapes below are a best
// guess pending the 9:00 AM opening; test against the live twin in the first 45 minutes.

export interface LinkedinApiOptions {
  baseUrl?: string;
  token?: string;
}

interface TwinMentionsResponse {
  posts: {
    id: string;
    author_name: string;
    author_type: 'publication' | 'program' | 'person' | 'self';
    author_domain?: string;
    text: string;
    url?: string | null;
    created_at?: string | null;
  }[];
}

interface TwinProfileResponse {
  followers: number;
}

async function twinFetch(baseUrl: string, path: string, token?: string): Promise<Response> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404 || res.status >= 500) throw new AppUnavailableError('linkedin');
  return res;
}

export function createLinkedinApi(opts: LinkedinApiOptions): LinkedinApi | null {
  if (!opts.baseUrl) return null;
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');

  return {
    async listMentions(profileId: string): Promise<LinkedinPost[]> {
      const res = await twinFetch(baseUrl, `/v2/mentions?profile=${encodeURIComponent(profileId)}`, opts.token);
      if (!res.ok) throw new AppUnavailableError('linkedin');
      const body = (await res.json()) as TwinMentionsResponse;
      return (body.posts ?? []).map((p) => ({
        id: p.id,
        authorName: p.author_name,
        authorType: p.author_type,
        authorDomain: p.author_domain,
        text: p.text,
        url: p.url ?? null,
        createdAt: p.created_at ?? null,
      }));
    },
    async getProfile(profileId: string): Promise<{ followers: number }> {
      const res = await twinFetch(baseUrl, `/v2/profiles/${encodeURIComponent(profileId)}`, opts.token);
      if (!res.ok) throw new AppUnavailableError('linkedin');
      const body = (await res.json()) as TwinProfileResponse;
      return { followers: body.followers ?? 0 };
    },
  };
}
