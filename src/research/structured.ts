import type { ApiCandidate, VerifierAdapter } from '../integrations/types.js';
import type { FounderProfile } from '../types.js';
import type { ResearchRequest } from './types.js';
import type { StructuredResearch } from '../integrations/types.js';

// The structured-sources-first research layer (PRD 6.11, 6.14): the Corroborator calls this
// before any web search. It fans a ResearchRequest out to whichever verifier APIs apply to the
// exhibit and criterion, collects their ApiCandidate[] (each already carrying its raw response as
// the snapshot), and sets `limited: true` when any selected adapter hit a free-tier limit so the
// exhibit is deferred to the next run instead of falling back to web search (E68, constraint 14:
// never use a source outside the primary/verifier lists, even as a lead — falling back to the open
// web after an API 429 would do exactly that).
//
// NEEDS CORE PATCH (not owned here): `ResearchRequest` (src/research/types.ts) has no `profile`
// field, but VerifierAdapter#figures needs profile.socCode/jobTitle for the #8 BLS/O*NET path.
// Declaration-merged below so this file type-checks without editing that file; the real fix is to
// add `profile: FounderProfile;` to ResearchRequest in src/research/types.ts and have
// src/research/corroborator.ts pass `deps.profile` when it builds the request (see the "core
// patches needed" note in this package's final report).
declare module './types.js' {
  interface ResearchRequest {
    profile?: FounderProfile;
  }
}

const GITHUB_HOST_RE = /(^|\.)github\.com$/i;
const DOI_RE = /doi\.org\//i;

function isGithubExhibit(req: ResearchRequest): boolean {
  if (req.exhibit.issuer === 'github.com') return true;
  const urls = req.exhibit.sources.map((s) => s.url).filter((u): u is string => !!u);
  return urls.some((u) => {
    try {
      return GITHUB_HOST_RE.test(new URL(u).hostname);
    } catch {
      return false;
    }
  });
}

function hasDoi(req: ResearchRequest): boolean {
  const meta = req.exhibit.metrics as Record<string, unknown>;
  if (typeof meta.doi === 'string') return true;
  const urls = req.exhibit.sources.map((s) => s.url).filter((u): u is string => !!u);
  return urls.some((u) => DOI_RE.test(u));
}

export interface StructuredResearchOptions {
  adapters: VerifierAdapter[];
}

/** Selects which of the configured adapters apply to this exhibit/criterion (6.14 routing). */
function selectAdapters(adapters: VerifierAdapter[], req: ResearchRequest): VerifierAdapter[] {
  const byId = new Map(adapters.map((a) => [a.info.id, a]));
  const selected: VerifierAdapter[] = [];
  if (isGithubExhibit(req)) {
    if (byId.has('platformstats')) selected.push(byId.get('platformstats')!);
    if (byId.has('ecosystems')) selected.push(byId.get('ecosystems')!);
  }
  if (hasDoi(req)) {
    for (const id of ['openalex', 'crossref', 'semanticscholar']) if (byId.has(id)) selected.push(byId.get(id)!);
  }
  if (req.criterion === 8) {
    if (byId.has('bls')) selected.push(byId.get('bls')!);
    if (byId.has('onet')) selected.push(byId.get('onet')!);
  }
  return selected;
}

export function createStructuredResearch(opts: StructuredResearchOptions): StructuredResearch {
  return {
    kind: 'verifier-apis',
    async propose(req: ResearchRequest) {
      const candidates: ApiCandidate[] = [];
      const errors: string[] = [];
      let limited = false;
      const selected = selectAdapters(opts.adapters, req);
      for (const adapter of selected) {
        const result = await adapter.figures({ exhibit: req.exhibit, criterion: req.criterion, profile: req.profile! });
        candidates.push(...result.candidates);
        errors.push(...result.errors);
        if (result.limited) limited = true;
      }
      return { candidates, errors, limited };
    },
  };
}
