import type { DiscoveredItem, DiscoveryAdapter, DiscoveryQuery, DiscoveryResult, HttpTransport, IntegrationInfo } from './types.js';

// Hugging Face Hub discovery adapter (PRD 6.14). Free, optional token for a higher rate limit. Lists
// models (and datasets) published under the founder's own handles; downloads and likes back #5
// (C5-model-adoption) once the discovery classifier applies the working threshold.

const BASE_URL = 'https://huggingface.co/api';

interface HfModel {
  id: string;
  author?: string;
  downloads?: number;
  likes?: number;
  lastModified?: string;
  createdAt?: string;
  tags?: string[];
}

export interface HuggingFaceAdapterOptions {
  transport: HttpTransport;
  token?: string;
  baseUrl?: string;
}

export function createHuggingFaceAdapter(opts: HuggingFaceAdapterOptions): DiscoveryAdapter {
  const base = opts.baseUrl ?? BASE_URL;
  const { transport, token } = opts;

  const info: IntegrationInfo = {
    id: 'huggingface',
    name: 'Hugging Face Hub',
    job: ['discover'],
    tier: 1,
    criteria: '#5',
    freeTier: 'Free, optional token',
    credentials: token ? ['token'] : [],
    receives: "The founder's own Hugging Face handles, as author filters",
  };

  function toItem(m: HfModel, kind: 'models' | 'datasets', handle: string): DiscoveredItem {
    const publishedAt = m.createdAt ?? m.lastModified ?? null;
    // Identity comes from the account, not from text Exhibit writes: the item was listed under one of
    // the founder's own handles, recorded as meta.ownerHandle for the second-identifier rule.
    const text = `${kind === 'datasets' ? 'Dataset' : 'Model'}: ${m.id}\nOwner handle: ${m.author ?? handle}\nDownloads: ${m.downloads ?? 0}\nLikes: ${m.likes ?? 0}`;
    return {
      source: 'huggingface',
      externalId: `${kind}/${m.id}`,
      kind: 'model',
      url: `https://huggingface.co/${kind === 'datasets' ? 'datasets/' : ''}${m.id}`,
      title: m.id,
      text,
      publishedAt,
      author: { handle: m.author },
      meta: { downloads: m.downloads ?? 0, likes: m.likes ?? 0, ownerHandle: handle },
      raw: JSON.stringify(m),
    };
  }

  async function fetchAuthored(kind: 'models' | 'datasets', author: string): Promise<{ items: HfModel[]; limited: boolean; error?: string }> {
    const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
    const url = `${base}/${kind}?author=${encodeURIComponent(author)}`;
    const res = await transport.request({ method: 'GET', url, headers });
    if (res.status === 429) return { items: [], limited: true };
    if (res.status >= 400) return { items: [], limited: false, error: `Hugging Face ${kind} lookup failed: ${res.status}` };
    return { items: JSON.parse(res.body) as HfModel[], limited: false };
  }

  return {
    info,
    async discover(q: DiscoveryQuery): Promise<DiscoveryResult> {
      const items: DiscoveredItem[] = [];
      const errors: string[] = [];
      let limited = false;
      const seen = new Set<string>();

      for (const handle of q.handles.filter(Boolean)) {
        for (const kind of ['models', 'datasets'] as const) {
          try {
            const { items: found, limited: wasLimited, error } = await fetchAuthored(kind, handle);
            if (wasLimited) limited = true;
            if (error) errors.push(error);
            for (const m of found) {
              const key = `${kind}/${m.id}`;
              if (seen.has(key)) continue;
              seen.add(key);
              items.push(toItem(m, kind, handle));
            }
          } catch (err) {
            errors.push(err instanceof Error ? err.message : String(err));
          }
        }
      }

      return { items, errors, limited };
    },
  };
}
