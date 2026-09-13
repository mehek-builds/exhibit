import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FixtureTransport } from '../src/integrations/types.js';
import type { DiscoveryQuery } from '../src/integrations/types.js';
import { createHackerNewsAdapter } from '../src/integrations/hackernews.js';
import { createProductHuntAdapter } from '../src/integrations/producthunt.js';
import { createPodcastIndexAdapter } from '../src/integrations/podcastindex.js';
import { createUsptoAdapter } from '../src/integrations/uspto.js';
import { DISCOVERY_TIER2A_FIXTURES } from '../harness/fixtures/discovery-tier2a.js';

// PRD 6.14 Tier 2a discovery adapters: Hacker News, Product Hunt, Podcast Index, USPTO. Tests cover
// normalization, request construction, since-date filtering, 429 -> limited, API error -> errors
// (never throw), and honest normalization of namesake records (rejection is the discovery
// extension's job, per discovery.json's X-second-identifier / T-namesake rules).

const Q: DiscoveryQuery = {
  founderName: 'Dara Voss',
  aliases: ['Dara', 'D. Voss'],
  company: 'Loomwork',
  companyDomain: 'loomwork.example',
  handles: ['dvoss', 'loomwork'],
  coauthors: [],
  since: '2026-01-01T00:00:00.000Z',
};

describe('Hacker News adapter', () => {
  const adapter = createHackerNewsAdapter({ transport: new FixtureTransport(DISCOVERY_TIER2A_FIXTURES) });

  it('has accurate info', () => {
    expect(adapter.info.id).toBe('hackernews');
    expect(adapter.info.credentials).toEqual([]);
  });

  it('normalizes a Show HN post submitted by dvoss as launch, submittedByFounder true', async () => {
    const res = await adapter.discover(Q);
    expect(res.errors).toEqual([]);
    const showHn = res.items.find((i) => i.externalId === 'hn-1001');
    expect(showHn).toBeDefined();
    expect(showHn!.kind).toBe('launch');
    expect(showHn!.submittedByFounder).toBe(true);
    expect(showHn!.text).toContain('Loomwork');
    expect(showHn!.meta.submitter).toBe('dvoss');
  });

  it('normalizes a third-party story about Loomwork as article, submittedByFounder false', async () => {
    const res = await adapter.discover(Q);
    const story = res.items.find((i) => i.externalId === 'hn-1002');
    expect(story).toBeDefined();
    expect(story!.kind).toBe('article');
    expect(story!.submittedByFounder).toBe(false);
    expect(story!.text).toContain('Dara Voss');
  });

  it('normalizes a namesake story honestly (no rejection here)', async () => {
    const res = await adapter.discover(Q);
    const namesake = res.items.find((i) => i.externalId === 'hn-1003');
    expect(namesake).toBeDefined();
    expect(namesake!.text).not.toContain('Loomwork');
  });

  it('builds the Algolia query URL with tags=story and a since filter', async () => {
    const transport = new FixtureTransport(DISCOVERY_TIER2A_FIXTURES);
    const a = createHackerNewsAdapter({ transport });
    await a.discover(Q);
    const req = transport.requests.find((r) => r.url.includes('query=Loomwork'));
    expect(req).toBeDefined();
    expect(req!.url).toContain('tags=story');
    expect(req!.url).toContain('numericFilters=created_at_i%3E');
  });

  it('429 sets limited, never throws', async () => {
    const transport = new FixtureTransport(DISCOVERY_TIER2A_FIXTURES);
    const a = createHackerNewsAdapter({ transport });
    const res = await a.discover({ ...Q, founderName: '429', aliases: [], company: '429' });
    expect(res.limited).toBe(true);
    expect(res.errors).toEqual([]);
  });
});

describe('Product Hunt adapter', () => {
  function make() {
    const transport = new FixtureTransport(DISCOVERY_TIER2A_FIXTURES);
    return { transport, adapter: createProductHuntAdapter({ transport, token: 'ph-token' }) };
  }

  it('has accurate info noting the commercial-use caveat', () => {
    const { adapter } = make();
    expect(adapter.info.id).toBe('producthunt');
    expect(adapter.info.freeTier).toMatch(/commercial use/i);
  });

  it('normalizes a launch and splits Product of the Day into a separate badge item', async () => {
    const { adapter } = make();
    const res = await adapter.discover(Q);
    expect(res.errors).toEqual([]);
    const launch = res.items.find((i) => i.kind === 'launch');
    expect(launch).toBeDefined();
    expect(launch!.meta.votes).toBe(612);
    expect(launch!.meta.submitter).toBe('dvoss');
    const badge = res.items.find((i) => i.kind === 'badge');
    expect(badge).toBeDefined();
    expect(badge!.meta.badge).toBe('Product of the Day');
    expect(badge!.externalId).not.toBe(launch!.externalId);
  });

  it('sends a Bearer token in the Authorization header on a POST', async () => {
    const { transport, adapter } = make();
    await adapter.discover(Q);
    const req = transport.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.headers?.authorization).toBe('Bearer ph-token');
  });

  it('normalizes a namesake post honestly', async () => {
    const { adapter } = make();
    const res = await adapter.discover(Q);
    const namesake = res.items.find((i) => i.externalId === 'ph-501');
    expect(namesake).toBeDefined();
    expect(namesake!.text).toContain('DaraCam');
  });

  it('a documented quota GraphQL error sets limited, never throws', async () => {
    const { adapter } = make();
    const res = await adapter.discover({ ...Q, company: '429trigger', founderName: '429trigger' });
    expect(res.limited).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it('a GraphQL error (non-quota) is collected in errors, not thrown', async () => {
    const transport = new FixtureTransport({
      'POST https://api.producthunt.com/v2/api/graphql': { status: 200, headers: {}, body: JSON.stringify({ errors: [{ message: 'field not found' }] }) },
    });
    const adapter = createProductHuntAdapter({ transport, token: 't' });
    const res = await adapter.discover(Q);
    expect(res.errors.length).toBeGreaterThan(0);
    expect(res.limited).toBeFalsy();
  });
});

describe('Podcast Index adapter', () => {
  const NOW = 1_750_000_000;
  function make() {
    const transport = new FixtureTransport(DISCOVERY_TIER2A_FIXTURES);
    return { transport, adapter: createPodcastIndexAdapter({ transport, apiKey: 'key123', apiSecret: 'secret456', now: () => NOW }) };
  }

  it('has accurate info', () => {
    const { adapter } = make();
    expect(adapter.info.id).toBe('podcastindex');
    expect(adapter.info.credentials).toEqual(['apiKey', 'apiSecret (signed request headers)']);
  });

  it('signs the request with X-Auth-Key, X-Auth-Date and a sha1 Authorization header', async () => {
    const { transport, adapter } = make();
    await adapter.discover(Q);
    const req = transport.requests[0]!;
    expect(req.headers?.['X-Auth-Key']).toBe('key123');
    expect(req.headers?.['X-Auth-Date']).toBe(String(NOW));
    const expected = createHash('sha1').update('key123' + 'secret456' + String(NOW)).digest('hex');
    expect(req.headers?.['Authorization']).toBe(expected);
    expect(req.headers?.['User-Agent']).toBeTruthy();
  });

  it('normalizes an episode with Dara as guest, ISO datePublished', async () => {
    const { adapter } = make();
    const res = await adapter.discover(Q);
    const ep = res.items.find((i) => i.externalId === '9001');
    expect(ep).toBeDefined();
    expect(ep!.kind).toBe('podcast_episode');
    expect(ep!.meta.show).toBe('Infra Weekly');
    expect(ep!.meta.episode).toContain('Dara Voss');
    expect(ep!.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(ep!.text).toContain('Dara Voss');
    expect(ep!.text).toContain('Loomwork');
  });

  it('normalizes a namesake episode honestly', async () => {
    const { adapter } = make();
    const res = await adapter.discover(Q);
    const namesake = res.items.find((i) => i.externalId === '9002');
    expect(namesake).toBeDefined();
    expect(namesake!.meta.show).toBe('Outdoor Cast');
    expect(namesake!.text).toContain('no relation to Loomwork');
  });

  it('filters out episodes published before `since`', async () => {
    const { adapter } = make();
    const res = await adapter.discover({ ...Q, since: '2026-05-01T00:00:00.000Z' });
    expect(res.items.find((i) => i.externalId === '9001')).toBeUndefined();
  });

  it('429 sets limited, never throws', async () => {
    const { adapter } = make();
    const res = await adapter.discover({ ...Q, founderName: '429', aliases: [] });
    expect(res.limited).toBe(true);
    expect(res.errors).toEqual([]);
  });
});

describe('USPTO PatentSearch adapter', () => {
  function make() {
    const transport = new FixtureTransport(DISCOVERY_TIER2A_FIXTURES);
    return { transport, adapter: createUsptoAdapter({ transport, apiKey: 'uspto-key' }) };
  }

  it('has accurate info', () => {
    const { adapter } = make();
    expect(adapter.info.id).toBe('uspto');
    expect(adapter.info.credentials).toEqual(['apiKey']);
  });

  it('sends the X-Api-Key header and an inventor-name query', async () => {
    const { transport, adapter } = make();
    await adapter.discover(Q);
    const req = transport.requests[0]!;
    expect(req.headers?.['X-Api-Key']).toBe('uspto-key');
    const url = decodeURIComponent(req.url);
    expect(url).toContain('"inventors.inventor_name_last":"Voss"');
    expect(url).toContain('"inventors.inventor_name_first":"Dara"');
  });

  it('normalizes a patent naming Dara Voss, assignee Loomwork, Inc., status granted', async () => {
    const { adapter } = make();
    const res = await adapter.discover(Q);
    const patent = res.items.find((i) => i.externalId === '11234567');
    expect(patent).toBeDefined();
    expect(patent!.kind).toBe('patent');
    expect(patent!.meta.status).toBe('granted');
    expect(patent!.meta.patent_number).toBe('11234567');
    expect((patent!.meta.inventors as string[])).toContain('Dara Voss');
    expect(patent!.text).toContain('Loomwork, Inc.');
  });

  it('normalizes a namesake patent (different assignee) honestly', async () => {
    const { adapter } = make();
    const res = await adapter.discover(Q);
    const namesake = res.items.find((i) => i.externalId === '10999999');
    expect(namesake).toBeDefined();
    expect(namesake!.text).toContain('TrailGear LLC');
  });

  it('a documented rate-limit response sets limited, never throws', async () => {
    const { adapter } = make();
    const res = await adapter.discover({ ...Q, founderName: '429trigger' });
    expect(res.limited).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it('a missing API key (401) is collected in errors, not thrown', async () => {
    const transport = new FixtureTransport({});
    const adapter = createUsptoAdapter({ transport, apiKey: '' });
    const res = await adapter.discover(Q);
    expect(res.errors.length).toBeGreaterThan(0);
  });
});
