import type { ApiCandidate, HttpTransport, IntegrationInfo, VerifierAdapter, VerifierRequest } from './types.js';

// ecosyste.ms verifier adapter (PRD 6.11, 6.14). The independent mirror for GitHub, npm and PyPI
// numbers: stars for a repo, downloads for a package. Free, no key. Structured source, queried
// before web search; pairs with src/integrations/platformstats.ts (the platform's own primary
// API) to independently confirm adoption figures for #5 and comparable-#3 evidence.
//
// CONFIRMED field names against the published OpenAPI specs:
// - repos.ecosyste.ms `GET /hosts/{host}/repositories/{repo}` -> `stargazers_count`
//   (https://raw.githubusercontent.com/ecosyste-ms/repos/main/openapi/api/v1/openapi.yaml,
//   `Repository` schema).
// - packages.ecosyste.ms `GET /registries/{registry}/packages/{name}` -> `downloads`, and
//   `dependent_repos_count` (unused here) on the `Package` schema itself
//   (https://raw.githubusercontent.com/ecosyste-ms/packages/main/openapi/api/v1/openapi.yaml).
//
// FIXED: the repos.ecosyste.ms `Repository` schema has NO `dependents_count` field — that field
// only exists on the separate `PackageUsage` object returned by
// `GET /usage/{ecosystem}/{package}` (and `.../dependent_repositories`) on packages.ecosyste.ms,
// which needs an ecosystem+package identity this adapter does not have from a bare GitHub repo
// full_name. This adapter previously read `repo.dependents_count` from the *repos* response, which
// the spec does not define (always undefined in production); that read is removed rather than
// wired to the wrong endpoint.
//
// Neither OpenAPI spec documents a `mailto` or User-Agent polite-pool parameter for these
// endpoints (both specs' `info.contact.email` is support@ecosyste.ms, but no such request
// parameter appears in either file), so none is added here.

const GITHUB_REPO_RE = /^https?:\/\/(?:www\.)?github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/i;

function fullNameFor(req: VerifierRequest): string | null {
  for (const s of req.exhibit.sources) {
    const m = s.url ? GITHUB_REPO_RE.exec(s.url) : null;
    if (m) return m[1]!;
  }
  const meta = req.exhibit.metrics as Record<string, unknown>;
  return typeof meta.repo === 'string' ? meta.repo : null;
}

interface EcosystemsRepo {
  stargazers_count?: number;
  updated_at?: string;
}

interface EcosystemsPackage {
  downloads?: number;
  dependent_repos_count?: number;
  latest_release_published_at?: string;
}

export interface EcosystemsAdapterOptions {
  transport: HttpTransport;
  reposBaseUrl?: string;
  packagesBaseUrl?: string;
}

function numberSentence(body: string, field: string, value: number): string | null {
  const m = new RegExp(`"${field}"\\s*:\\s*${value}\\b`).exec(body);
  return m ? m[0].replace(/\s+/g, ' ') : null;
}

export function createEcosystemsAdapter(opts: EcosystemsAdapterOptions): VerifierAdapter {
  const reposBase = opts.reposBaseUrl ?? 'https://repos.ecosyste.ms/api/v1';
  const packagesBase = opts.packagesBaseUrl ?? 'https://packages.ecosyste.ms/api/v1';
  const info: IntegrationInfo = {
    id: 'ecosystems',
    name: 'ecosyste.ms',
    job: ['verify'],
    tier: 1,
    criteria: '#5',
    freeTier: 'Free',
    credentials: [],
    receives: "The founder's public name, company and handles, as search queries",
  };

  return {
    info,
    async figures(req: VerifierRequest) {
      const candidates: ApiCandidate[] = [];
      const errors: string[] = [];
      let limited = false;

      const fullName = fullNameFor(req);
      if (fullName) {
        const url = `${reposBase}/hosts/GitHub/repositories/${fullName}`;
        const res = await opts.transport.request({ method: 'GET', url });
        if (res.status === 429) {
          limited = true;
        } else if (res.status >= 400) {
          errors.push(`ecosyste.ms repositories fetch failed: ${res.status}`);
        } else {
          let repo: EcosystemsRepo;
          try {
            repo = JSON.parse(res.body) as EcosystemsRepo;
          } catch {
            errors.push('ecosyste.ms repositories response was not valid JSON');
            repo = {};
          }
          if (repo.stargazers_count !== undefined) {
            const sentence = numberSentence(res.body, 'stargazers_count', repo.stargazers_count);
            if (sentence) {
              candidates.push({
                source_class: 'api', measure: 'stars', value: repo.stargazers_count, unit: 'stars', sentence, url,
                publisher: 'ecosyste.ms', kind: 'verifier', as_of: repo.updated_at ?? new Date().toISOString(), response: res.body,
              });
            }
          }
        }
      }

      const meta = req.exhibit.metrics as Record<string, unknown>;
      const registry = typeof meta.registry === 'string' ? meta.registry : null;
      const pkgName = typeof meta.package === 'string' ? meta.package : null;
      if (registry && pkgName) {
        const url = `${packagesBase}/registries/${encodeURIComponent(registry)}/packages/${encodeURIComponent(pkgName)}`;
        const res = await opts.transport.request({ method: 'GET', url });
        if (res.status === 429) {
          limited = true;
        } else if (res.status >= 400) {
          errors.push(`ecosyste.ms packages fetch failed: ${res.status}`);
        } else {
          let pkg: EcosystemsPackage;
          try {
            pkg = JSON.parse(res.body) as EcosystemsPackage;
          } catch {
            errors.push('ecosyste.ms packages response was not valid JSON');
            pkg = {};
          }
          if (pkg.downloads !== undefined) {
            const sentence = numberSentence(res.body, 'downloads', pkg.downloads);
            if (sentence) {
              candidates.push({
                source_class: 'api', measure: 'downloads', value: pkg.downloads, unit: 'downloads', sentence, url,
                publisher: 'ecosyste.ms', kind: 'verifier', as_of: pkg.latest_release_published_at ?? new Date().toISOString(), response: res.body,
              });
            }
          }
        }
      }

      return { candidates, errors, limited };
    },
  };
}
