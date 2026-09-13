import { describe, expect, it } from 'vitest';
import { domainOf, hostMatches } from '../src/util.js';
import { corroborate, sourcePolicy } from '../src/research/corroborator.js';
import type { CorroborateDeps } from '../src/research/corroborator.js';
import { FixtureFetcher, FixtureResearcher } from '../src/research/fixture.js';
import type { WebFixtures } from '../src/research/fixture.js';
import { ensureBinder } from '../src/binder/filer.js';
import type { FilerDeps } from '../src/binder/filer.js';
import { Ledger } from '../src/ledger.js';
import { LocalTracer } from '../src/observability/tracer.js';
import { loadGraph } from '../src/rules/graph.js';
import { MemoryTwins } from '../src/twins/memory.js';
import type { ExhibitRecord } from '../src/types.js';
import { NOW, seed } from '../harness/corpus.js';
import { PROFILE } from './helpers.js';

// Regression for the allowlist bypass: domainOf() used to treat ANY "@"-containing string as an
// email and return the text after the last "@", without ever parsing it as a URL. That meant a
// source URL like `https://evil.com/report@bls.gov` (real host: evil.com) was read as domain
// `bls.gov`, sailing past the Corroborator's allowed-domain gate and violating hard constraints
// 12/14 (figures only from the primary and verifier source lists).

describe('domainOf', () => {
  it('reads the real host out of the userinfo-trick bypass URL, not the text after the last @', () => {
    expect(domainOf('https://evil.com/report@bls.gov')).toBe('evil.com');
  });

  it('resolves URL userinfo to the actual host (https://bls.gov@evil.com/)', () => {
    expect(domainOf('https://bls.gov@evil.com/')).toBe('evil.com');
  });

  it('rejects a lookalike suffix host (evilbls.gov is not bls.gov)', () => {
    expect(domainOf('https://evilbls.gov/report')).toBe('evilbls.gov');
    expect(hostMatches('evilbls.gov', 'bls.gov')).toBe(false);
  });

  it('rejects a lookalike prefix host (bls.gov.evil.com is not bls.gov)', () => {
    expect(domainOf('https://bls.gov.evil.com/report')).toBe('bls.gov.evil.com');
    expect(hostMatches('bls.gov.evil.com', 'bls.gov')).toBe(false);
  });

  it('accepts a true subdomain', () => {
    expect(domainOf('https://data.bls.gov/report')).toBe('data.bls.gov');
    expect(hostMatches('data.bls.gov', 'bls.gov')).toBe(true);
  });

  it('still reads a plain email address correctly', () => {
    expect(domainOf('founder@example.com')).toBe('example.com');
  });

  it('strips a leading www. the same way for URLs', () => {
    expect(domainOf('https://www.bls.gov/report')).toBe('bls.gov');
  });

  it('returns null for garbage input', () => {
    expect(domainOf('not a url or email')).toBeNull();
    expect(domainOf('')).toBeNull();
    expect(domainOf(null)).toBeNull();
    expect(domainOf(undefined)).toBeNull();
  });
});

const graph = loadGraph();
const page = (title: string, ...paragraphs: string[]) => ({ status: 200, body: `<html><head><title>${title}</title></head><body>${paragraphs.map((p) => `<p>${p}</p>`).join('')}</body></html>` });

function exhibit(p: Partial<ExhibitRecord> & { exhibit_id: string; criteria: number[]; issuer: string }): ExhibitRecord {
  return {
    key: p.exhibit_id,
    eb1a_criteria: ['iii'],
    status: 'qualifying',
    eb1a_status: 'qualifying',
    comparable: false,
    comparable_for: [],
    rule_id: 'C3-press-about',
    metrics: {},
    title: 'An exhibit',
    event_date: '2026-01-01',
    captured_at: NOW.toISOString(),
    sources: [],
    artifact_path: '03-published-material/EX-3-001/',
    sha256: 'abc',
    reason: 'reason',
    version: 1,
    supersedes: null,
    people: [],
    ...p,
  } as ExhibitRecord;
}

async function makeDeps(fixtures: WebFixtures): Promise<{ deps: CorroborateDeps; ledger: Ledger }> {
  const twins = new MemoryTwins(seed({}), { now: () => NOW });
  const ledger = new Ledger(':memory:');
  const tracer = new LocalTracer(null);
  const trace = (await tracer.run({ name: 'test', runId: 'r1', input: {} }, async (c) => c)).result;
  const filerDeps: FilerDeps = { drive: twins.apps.drive, ledger, trace, profile: PROFILE, runId: 'r1', now: NOW };
  const binder = await ensureBinder(filerDeps);
  const policy = sourcePolicy(graph, true);
  const deps: CorroborateDeps = {
    drive: twins.apps.drive, ledger, trace, graph,
    researcher: new FixtureResearcher(fixtures),
    fetcher: new FixtureFetcher(fixtures),
    policy, binder, runId: 'r1', now: NOW,
  };
  return { deps, ledger };
}

describe('corroborator: userinfo-trick URL is blocked, not read as bls.gov', () => {
  const fixtures: WebFixtures = {
    pages: {
      'https://evil.com/report@bls.gov': page('Fake BLS mirror', 'This role sees 5,000 openings annually.'),
    },
    research: {
      'coolthing.example': [
        {
          measure: 'openings',
          value: 5_000,
          unit: 'people',
          sentence: 'This role sees 5,000 openings annually.',
          url: 'https://evil.com/report@bls.gov',
          publisher: 'Fake BLS mirror',
          kind: 'verifier',
          as_of: '2026-08-01',
        },
      ],
    },
  };

  it('blocks the figure sourced from https://evil.com/report@bls.gov as domain not on the allowlist', async () => {
    const { deps } = await makeDeps(fixtures);
    const ex = exhibit({ exhibit_id: 'EX-3-200', criteria: [3], issuer: 'coolthing.example' });
    const summary = await corroborate([ex], deps);
    expect(summary.blocked.some((b) => b.url === 'https://evil.com/report@bls.gov' && b.reason.includes('not on the primary or verifier list'))).toBe(true);
    expect(summary.queued).toHaveLength(0);
  });
});
