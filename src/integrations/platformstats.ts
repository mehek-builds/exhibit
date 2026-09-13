import type { ApiCandidate, HttpTransport, IntegrationInfo, VerifierAdapter, VerifierRequest } from './types.js';

// Platform statistics verifier adapter (PRD 6.11 "platform numbers follow the same rule", 6.14).
// GitHub REST is the primary source for a github.com exhibit's stars and forks; Hugging Face Hub
// is the primary source for a model's downloads (#5). Each pairs with the ecosyste.ms verifier
// mirror (src/integrations/ecosystems.ts) for the second source. Both are free; GitHub is
// unauthenticated (60 req/hr) unless a token is supplied, Hugging Face token is optional.

const GITHUB_REPO_RE = /^https?:\/\/(?:www\.)?github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/i;
const HF_MODEL_RE = /^https?:\/\/(?:www\.)?huggingface\.co\/(?!datasets\/)([^/?#]+\/[^/?#]+)/i;

function githubFullName(req: VerifierRequest): string | null {
  for (const s of req.exhibit.sources) {
    const m = s.url ? GITHUB_REPO_RE.exec(s.url) : null;
    if (m) return m[1]!;
  }
  const meta = req.exhibit.metrics as Record<string, unknown>;
  return typeof meta.repo === 'string' ? meta.repo : null;
}

function hfModelId(req: VerifierRequest): string | null {
  for (const s of req.exhibit.sources.map((s) => s.url)) {
    const m = s ? HF_MODEL_RE.exec(s) : null;
    if (m) return m[1]!;
  }
  const meta = req.exhibit.metrics as Record<string, unknown>;
  return typeof meta.hf_model === 'string' ? meta.hf_model : null;
}

interface GithubRepoResponse {
  stargazers_count?: number;
  forks_count?: number;
  pushed_at?: string;
}

interface HfModelResponse {
  downloads?: number;
  lastModified?: string;
}

function numberSentence(body: string, field: string, value: number): string | null {
  const m = new RegExp(`"${field}"\\s*:\\s*${value}\\b`).exec(body);
  return m ? m[0].replace(/\s+/g, ' ') : null;
}

export interface PlatformStatsAdapterOptions {
  transport: HttpTransport;
  githubToken?: string;
  huggingFaceToken?: string;
  githubBaseUrl?: string;
  huggingFaceBaseUrl?: string;
}

export function createPlatformStatsAdapter(opts: PlatformStatsAdapterOptions): VerifierAdapter {
  const githubBase = opts.githubBaseUrl ?? 'https://api.github.com';
  const hfBase = opts.huggingFaceBaseUrl ?? 'https://huggingface.co/api';
  const info: IntegrationInfo = {
    id: 'platformstats',
    name: 'Platform statistics (GitHub + Hugging Face)',
    job: ['verify'],
    tier: 1,
    criteria: '#3, #5',
    freeTier: 'GitHub REST free (unauthenticated 60 req/hr); Hugging Face free, optional token',
    credentials: ['Optional GitHub token', 'Optional Hugging Face token'],
    receives: "The founder's public name, company and handles, as search queries",
  };

  return {
    info,
    async figures(req: VerifierRequest) {
      const candidates: ApiCandidate[] = [];
      const errors: string[] = [];
      let limited = false;

      const fullName = githubFullName(req);
      if (fullName) {
        const url = `${githubBase}/repos/${fullName}`;
        const headers: Record<string, string> = opts.githubToken ? { authorization: `Bearer ${opts.githubToken}` } : {};
        const res = await opts.transport.request({ method: 'GET', url, headers });
        if (res.status === 429 || res.status === 403) {
          limited = true;
        } else if (res.status >= 400) {
          errors.push(`GitHub repo fetch failed: ${res.status}`);
        } else {
          let repo: GithubRepoResponse;
          try {
            repo = JSON.parse(res.body) as GithubRepoResponse;
          } catch {
            errors.push('GitHub repo response was not valid JSON');
            repo = {};
          }
          if (repo.stargazers_count !== undefined) {
            const sentence = numberSentence(res.body, 'stargazers_count', repo.stargazers_count);
            if (sentence) {
              candidates.push({
                source_class: 'api', measure: 'stars', value: repo.stargazers_count, unit: 'stars', sentence, url,
                publisher: 'GitHub', kind: 'primary', as_of: repo.pushed_at ?? new Date().toISOString(), response: res.body,
              });
            }
          }
          if (repo.forks_count !== undefined) {
            const sentence = numberSentence(res.body, 'forks_count', repo.forks_count);
            if (sentence) {
              candidates.push({
                source_class: 'api', measure: 'forks', value: repo.forks_count, unit: 'forks', sentence, url,
                publisher: 'GitHub', kind: 'primary', as_of: repo.pushed_at ?? new Date().toISOString(), response: res.body,
              });
            }
          }
        }
      }

      const modelId = hfModelId(req);
      if (modelId) {
        const url = `${hfBase}/models/${modelId}`;
        const headers: Record<string, string> = opts.huggingFaceToken ? { authorization: `Bearer ${opts.huggingFaceToken}` } : {};
        const res = await opts.transport.request({ method: 'GET', url, headers });
        if (res.status === 429) {
          limited = true;
        } else if (res.status >= 400) {
          errors.push(`Hugging Face model fetch failed: ${res.status}`);
        } else {
          let model: HfModelResponse;
          try {
            model = JSON.parse(res.body) as HfModelResponse;
          } catch {
            errors.push('Hugging Face model response was not valid JSON');
            model = {};
          }
          if (model.downloads !== undefined) {
            const sentence = numberSentence(res.body, 'downloads', model.downloads);
            if (sentence) {
              candidates.push({
                source_class: 'api', measure: 'downloads', value: model.downloads, unit: 'downloads', sentence, url,
                publisher: 'Hugging Face', kind: 'primary', as_of: model.lastModified ?? new Date().toISOString(), response: res.body,
              });
            }
          }
        }
      }

      return { candidates, errors, limited };
    },
  };
}
