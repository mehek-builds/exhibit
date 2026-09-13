// Live smoke test for Exhibit's keyless public integrations (constraint 19: never call an integration
// "live" unless it ran in this build). Exercises real network endpoints with neutral, non-personal
// queries and records only status/shape/latency -- never response bodies (see docs/integrations/LIVE-SMOKE.md).
//
// Run: npx tsx scripts/live-smoke.ts

import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { FetchTransport } from '../src/integrations/types.js';
import type { ExhibitRecord, FounderProfile, SourceRef } from '../src/types.js';
import { createGdeltAdapter } from '../src/integrations/gdelt.js';
import { createHackerNewsAdapter } from '../src/integrations/hackernews.js';
import { createCrossrefAdapter } from '../src/integrations/crossref.js';
import { createEcosystemsAdapter } from '../src/integrations/ecosystems.js';
import { createPlatformStatsAdapter } from '../src/integrations/platformstats.js';
import { createBlsAdapter } from '../src/integrations/bls.js';
import { createSemanticScholarAdapter } from '../src/integrations/semanticscholar.js';
import { createOpenAlexAdapter } from '../src/integrations/openalex.js';
import { createHuggingFaceAdapter } from '../src/integrations/huggingface.js';
import { createEdgarAdapter } from '../src/integrations/edgar.js';
import { archivePage } from '../src/integrity/archive.js';
import { stampDigest } from '../src/integrity/opentimestamps.js';

interface Result {
  service: string;
  endpoint: string;
  status: number | null;
  parseOk: boolean | null;
  counts?: Record<string, number>;
  latencyMs: number | null;
  error?: string;
  skipped?: string;
}

const results: Result[] = [];
const transport = new FetchTransport({ userAgent: 'Exhibit-live-smoke/0.1 (+https://github.com/exhibit; smoke test, no PII)' });

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T | null; ms: number; err?: string }> {
  const start = Date.now();
  try {
    const value = await fn();
    return { value, ms: Date.now() - start };
  } catch (e) {
    return { value: null, ms: Date.now() - start, err: e instanceof Error ? e.message : String(e) };
  }
}

const DOI = '10.1038/nature14539';
const GITHUB_REPO_URL = 'https://github.com/opentimestamps/opentimestamps-client';
const ECOSYSTEMS_REPO_URL = 'https://github.com/opentimestamps/opentimestamps-client';
const ARCHIVE_URL = 'https://opentimestamps.org';

// 2026-09-13 re-run: --only gdelt,semanticscholar with queries chosen to actually produce non-empty
// results (see docs/integrations/LIVE-SMOKE.md re-run section). No personal data in either query.
const GDELT_FOUNDER = 'Federal Reserve';
const GDELT_COMPANY = 'interest rates';
const S2_DOIS = ['10.48550/arXiv.1706.03762', '10.1145/3292500.3330701'];

function parseOnly(): Set<string> | null {
  const arg = process.argv.find((a) => a === '--only' || a.startsWith('--only='));
  if (!arg) return null;
  const value = arg.includes('=') ? arg.split('=')[1] : process.argv[process.argv.indexOf(arg) + 1];
  if (!value) return null;
  return new Set(value.split(',').map((s) => s.trim()).filter(Boolean));
}

const ONLY = parseOnly();
function shouldRun(service: string): boolean {
  return !ONLY || ONLY.has(service);
}

function fakeExhibit(sources: SourceRef[], metrics: Record<string, string | number> = {}): ExhibitRecord {
  return {
    exhibit_id: 'smoke-1',
    key: 'smoke-1',
    criteria: [5],
    eb1a_criteria: [],
    status: 'building',
    eb1a_status: 'building',
    comparable: false,
    comparable_for: [],
    rule_id: 'smoke',
    metrics,
    title: 'smoke test',
    issuer: null,
    event_date: null,
    captured_at: new Date().toISOString(),
    sources,
    artifact_path: '',
    sha256: '',
    reason: 'live smoke test, not a real exhibit',
    version: 1,
  } as ExhibitRecord;
}

const fakeProfile: FounderProfile = {
  name: 'Smoke Test',
  aliases: [],
  emails: [],
  domain: 'example.com',
  company: 'Example Co',
  githubLogins: [],
  ownAccounts: [],
  linkedinId: '',
  field: 'software',
  targetFilingDate: '2027-01-01',
  recommenderCandidates: [],
  socCode: '15-1252',
} as unknown as FounderProfile;

async function run() {
  // --- GDELT (discover) ---
  if (shouldRun('gdelt')) {
    const adapter = createGdeltAdapter({ transport });
    const { value, ms, err } = await timed(() =>
      adapter.discover({ founderName: GDELT_FOUNDER, aliases: [], company: GDELT_COMPANY, companyDomain: 'un.org', handles: [], coauthors: [], since: '2020-01-01T00:00:00Z' }),
    );
    if (err) {
      results.push({ service: 'gdelt', endpoint: 'api.gdeltproject.org/api/v2/doc/doc', status: null, parseOk: null, latencyMs: ms, error: err });
    } else {
      results.push({ service: 'gdelt', endpoint: 'api.gdeltproject.org/api/v2/doc/doc', status: value!.errors.length ? null : 200, parseOk: value!.errors.length === 0, counts: { items: value!.items.length }, latencyMs: ms, error: value!.errors.join('; ') || undefined });
    }
    await sleep(2100);
  }

  // --- Hacker News (discover) ---
  if (shouldRun('hackernews')) {
    const adapter = createHackerNewsAdapter({ transport });
    const { value, ms, err } = await timed(() =>
      adapter.discover({ founderName: 'opentimestamps', aliases: [], company: 'opentimestamps', companyDomain: 'opentimestamps.org', handles: [], coauthors: [], since: '2020-01-01T00:00:00Z' }),
    );
    if (err) {
      results.push({ service: 'hackernews', endpoint: 'hn.algolia.com/api/v1/search', status: null, parseOk: null, latencyMs: ms, error: err });
    } else {
      results.push({ service: 'hackernews', endpoint: 'hn.algolia.com/api/v1/search', status: value!.errors.length ? null : 200, parseOk: value!.errors.length === 0, counts: { items: value!.items.length }, latencyMs: ms, error: value!.errors.join('; ') || undefined });
    }
    await sleep(2100);
  }

  // --- Crossref (verify) ---
  if (shouldRun('crossref')) {
    const adapter = createCrossrefAdapter({ transport, mailto: 'smoke-test@example.com' });
    const req = { exhibit: fakeExhibit([{ app: 'discovery', id: 'x', url: `https://doi.org/${DOI}` }]), criterion: 6 as const, profile: fakeProfile };
    const { value, ms, err } = await timed(() => adapter.figures(req));
    if (err) {
      results.push({ service: 'crossref', endpoint: 'api.crossref.org/works/{doi}', status: null, parseOk: null, latencyMs: ms, error: err });
    } else {
      results.push({ service: 'crossref', endpoint: 'api.crossref.org/works/{doi}', status: value!.errors.length ? null : 200, parseOk: value!.errors.length === 0 && value!.candidates.length > 0, counts: { candidates: value!.candidates.length }, latencyMs: ms, error: value!.errors.join('; ') || undefined });
    }
    await sleep(2100);
  }

  // --- ecosyste.ms (verify) ---
  if (shouldRun('ecosystems')) {
    const adapter = createEcosystemsAdapter({ transport });
    const req = { exhibit: fakeExhibit([{ app: 'discovery', id: 'x', url: ECOSYSTEMS_REPO_URL }]), criterion: 5 as const, profile: fakeProfile };
    const { value, ms, err } = await timed(() => adapter.figures(req));
    if (err) {
      results.push({ service: 'ecosystems', endpoint: 'repos.ecosyste.ms/.../repositories/{repo}', status: null, parseOk: null, latencyMs: ms, error: err });
    } else {
      results.push({ service: 'ecosystems', endpoint: 'repos.ecosyste.ms/.../repositories/{repo}', status: value!.errors.length ? null : 200, parseOk: value!.errors.length === 0, counts: { candidates: value!.candidates.length }, latencyMs: ms, error: value!.errors.join('; ') || undefined });
    }
    await sleep(2100);
  }

  // --- platformstats (GitHub REST only, unauthenticated) ---
  if (shouldRun('platformstats')) {
    const adapter = createPlatformStatsAdapter({ transport });
    const req = { exhibit: fakeExhibit([{ app: 'discovery', id: 'x', url: GITHUB_REPO_URL }]), criterion: 5 as const, profile: fakeProfile };
    const { value, ms, err } = await timed(() => adapter.figures(req));
    if (err) {
      results.push({ service: 'platformstats(github)', endpoint: 'api.github.com/repos/{owner}/{repo}', status: null, parseOk: null, latencyMs: ms, error: err });
    } else {
      results.push({ service: 'platformstats(github)', endpoint: 'api.github.com/repos/{owner}/{repo}', status: value!.errors.length ? null : 200, parseOk: value!.errors.length === 0, counts: { candidates: value!.candidates.length }, latencyMs: ms, error: value!.errors.join('; ') || undefined });
    }
    await sleep(2100);
  }

  // --- BLS (documented unregistered path: v2 accepts an omitted/empty registrationkey with lower limits) ---
  if (shouldRun('bls')) {
    const adapter = createBlsAdapter({ transport, registrationKey: '' });
    const req = { exhibit: fakeExhibit([]), criterion: 8 as const, profile: fakeProfile };
    const { value, ms, err } = await timed(() => adapter.figures(req));
    if (err) {
      results.push({ service: 'bls', endpoint: 'api.bls.gov/publicAPI/v2/timeseries/data/', status: null, parseOk: null, latencyMs: ms, error: err });
    } else {
      results.push({ service: 'bls', endpoint: 'api.bls.gov/publicAPI/v2/timeseries/data/', status: value!.errors.length ? null : 200, parseOk: value!.errors.length === 0, counts: { candidates: value!.candidates.length }, latencyMs: ms, error: value!.errors.join('; ') || (value!.limited ? 'limited (no key)' : undefined) });
    }
    await sleep(2100);
  }

  // --- Semantic Scholar (unkeyed): try up to 2 well-known DOIs, >=2s apart, stop at first candidate ---
  if (shouldRun('semanticscholar')) {
    const adapter = createSemanticScholarAdapter({ transport });
    let last: Awaited<ReturnType<typeof timed<Awaited<ReturnType<typeof adapter.figures>>>>> | null = null;
    let usedDoi = S2_DOIS[0]!;
    for (let i = 0; i < S2_DOIS.length; i++) {
      usedDoi = S2_DOIS[i]!;
      const req = { exhibit: fakeExhibit([{ app: 'discovery', id: 'x', url: `https://doi.org/${usedDoi}` }]), criterion: 6 as const, profile: fakeProfile };
      last = await timed(() => adapter.figures(req));
      if (last.value && last.value.candidates.length > 0) break;
      if (i < S2_DOIS.length - 1) await sleep(2100);
    }
    const { value, ms, err } = last!;
    if (err) {
      results.push({ service: 'semanticscholar', endpoint: `api.semanticscholar.org/graph/v1/paper/DOI:${usedDoi}`, status: null, parseOk: null, latencyMs: ms, error: err });
    } else {
      results.push({ service: 'semanticscholar', endpoint: `api.semanticscholar.org/graph/v1/paper/DOI:${usedDoi}`, status: value!.errors.length ? null : 200, parseOk: value!.errors.length === 0 && value!.candidates.length > 0, counts: { candidates: value!.candidates.length }, latencyMs: ms, error: value!.errors.join('; ') || undefined });
    }
    await sleep(2100);
  }

  // --- OpenAlex (verify): citation count for a well-cited public DOI ---
  if (shouldRun('openalex')) {
    const adapter = createOpenAlexAdapter({ transport, mailto: 'smoke-test@example.com' });
    const req = { exhibit: fakeExhibit([{ app: 'discovery', id: 'x', url: `https://doi.org/${DOI}` }]), criterion: 6 as const, profile: fakeProfile };
    const { value, ms, err } = await timed(() => adapter.figures(req));
    if (err) {
      results.push({ service: 'openalex', endpoint: 'api.openalex.org/works/doi:{doi}', status: null, parseOk: null, latencyMs: ms, error: err });
    } else {
      results.push({ service: 'openalex', endpoint: 'api.openalex.org/works/doi:{doi}', status: value!.errors.length ? null : 200, parseOk: value!.errors.length === 0 && value!.candidates.length > 0, counts: { candidates: value!.candidates.length }, latencyMs: ms, error: value!.errors.join('; ') || undefined });
    }
    await sleep(2100);
  }

  // --- Hugging Face Hub (discover): models and datasets authored by a public org handle, no token ---
  if (shouldRun('huggingface')) {
    const adapter = createHuggingFaceAdapter({ transport });
    const { value, ms, err } = await timed(() =>
      adapter.discover({ founderName: 'Hugging Face', aliases: [], company: 'Hugging Face', companyDomain: 'huggingface.co', handles: ['openai'], coauthors: [], since: '2020-01-01T00:00:00Z' }),
    );
    if (err) {
      results.push({ service: 'huggingface', endpoint: 'huggingface.co/api/{models,datasets}?author=', status: null, parseOk: null, latencyMs: ms, error: err });
    } else {
      results.push({ service: 'huggingface', endpoint: 'huggingface.co/api/{models,datasets}?author=', status: value!.errors.length ? null : 200, parseOk: value!.errors.length === 0 && value!.items.length > 0, counts: { items: value!.items.length }, latencyMs: ms, error: value!.errors.join('; ') || undefined });
    }
    await sleep(2100);
  }

  // --- SEC EDGAR full-text search (discover): Form D filings for a public company name ---
  if (shouldRun('edgar')) {
    const adapter = createEdgarAdapter({ transport, userAgent: 'Exhibit live smoke test smoke-test@example.com' });
    const { value, ms, err } = await timed(() =>
      adapter.discover({ founderName: 'Anthropic', aliases: [], company: 'Anthropic, PBC', companyDomain: 'anthropic.com', handles: [], coauthors: [], since: '2020-01-01T00:00:00Z' }),
    );
    if (err) {
      results.push({ service: 'edgar', endpoint: 'efts.sec.gov/LATEST/search-index?forms=D', status: null, parseOk: null, latencyMs: ms, error: err });
    } else {
      results.push({ service: 'edgar', endpoint: 'efts.sec.gov/LATEST/search-index?forms=D', status: value!.errors.length ? null : 200, parseOk: value!.errors.length === 0 && value!.items.length > 0, counts: { items: value!.items.length }, latencyMs: ms, error: value!.errors.join('; ') || undefined });
    }
    await sleep(2100);
  }

  // --- Internet Archive availability API only (never Save Page Now, which needs keys) ---
  if (shouldRun('archive')) {
    const { value, ms, err } = await timed(() =>
      transport.request({ method: 'GET', url: `https://archive.org/wayback/available?url=${encodeURIComponent(ARCHIVE_URL)}` }),
    );
    if (err) {
      results.push({ service: 'archive(availability)', endpoint: 'archive.org/wayback/available', status: null, parseOk: null, latencyMs: ms, error: err });
    } else {
      let parseOk = false;
      let counts: Record<string, number> | undefined;
      try {
        const parsed = JSON.parse(value!.body) as { archived_snapshots?: { closest?: { available?: boolean } } };
        parseOk = 'archived_snapshots' in parsed;
        counts = { available: parsed.archived_snapshots?.closest?.available ? 1 : 0 };
      } catch {
        parseOk = false;
      }
      results.push({ service: 'archive(availability)', endpoint: 'archive.org/wayback/available', status: value!.status, parseOk, counts, latencyMs: ms, error: value!.status >= 400 ? `HTTP ${value!.status}` : undefined });
    }
    await sleep(2100);
  }

  // --- OpenTimestamps: only run if src/integrity/* type-checks clean (checked by caller before invoking) ---
  if (shouldRun('opentimestamps')) {
    if (process.env.SMOKE_SKIP_OTS === '1') {
      results.push({ service: 'opentimestamps', endpoint: 'a.pool.opentimestamps.org/digest', status: null, parseOk: null, latencyMs: null, skipped: 'src/integrity/* did not type-check cleanly at run time (see README note in script invocation)' });
    } else {
      const digest = randomBytes(32);
      const digestHex = digest.toString('hex');
      const { value, ms, err } = await timed(() => stampDigest(digestHex, { transport, calendars: ['https://a.pool.opentimestamps.org'] }));
      if (err) {
        results.push({ service: 'opentimestamps', endpoint: 'a.pool.opentimestamps.org/digest', status: null, parseOk: null, latencyMs: ms, error: err });
      } else {
        results.push({ service: 'opentimestamps', endpoint: 'a.pool.opentimestamps.org/digest', status: value!.errors.length ? null : 200, parseOk: value!.errors.length === 0 && value!.proof.paths.length > 0, counts: { paths: value!.proof.paths.length }, latencyMs: ms, error: value!.errors.join('; ') || undefined });
      }
    }
  }

  const report = { ranAt: new Date().toISOString(), results };
  mkdirSync(new URL('../reports/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../reports/live-smoke.json', import.meta.url), JSON.stringify(report, null, 2));

  console.log('\nservice'.padEnd(24) + 'status'.padEnd(8) + 'parseOk'.padEnd(9) + 'latencyMs'.padEnd(11) + 'note');
  for (const r of results) {
    const note = r.skipped ? `SKIPPED: ${r.skipped}` : r.error ?? (r.counts ? JSON.stringify(r.counts) : '');
    console.log(r.service.padEnd(24) + String(r.status ?? '-').padEnd(8) + String(r.parseOk ?? '-').padEnd(9) + String(r.latencyMs ?? '-').padEnd(11) + note);
  }
}

run();
