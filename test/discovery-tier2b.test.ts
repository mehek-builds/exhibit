import { describe, expect, it } from 'vitest';
import { FixtureTransport } from '../src/integrations/types.js';
import { createOpenReviewAdapter } from '../src/integrations/openreview.js';
import { createOrcidAdapter } from '../src/integrations/orcid.js';
import { createEdgarAdapter } from '../src/integrations/edgar.js';
import {
  OPENREVIEW_FIXTURES,
  OPENREVIEW_LIMITED_FIXTURES,
  ORCID_FIXTURES,
  ORCID_LIMITED_FIXTURES,
  EDGAR_FIXTURES,
  EDGAR_LIMITED_FIXTURES,
  DARA_VOSS_ORCID,
  DARA_VOSS_OPENREVIEW_PROFILE,
  OPENREVIEW_VENUES,
  NEURIPS_VENUE,
  ICML_VENUE,
  TIER2B_QUERY,
} from '../harness/fixtures/discovery-tier2b.js';

// Tier 2b discovery adapters (PRD 6.14): OpenReview, ORCID, SEC EDGAR. Normalization,
// auth flows and the fixed edge cases (E61 look-alike company, E62 declined assignment, E68 429).

describe('OpenReview adapter', () => {
  function build(fixtures = OPENREVIEW_FIXTURES) {
    const transport = new FixtureTransport(fixtures);
    const adapter = createOpenReviewAdapter({
      transport,
      username: 'dara@loomwork.example',
      password: 's3cret-pw',
      profileId: DARA_VOSS_OPENREVIEW_PROFILE,
      venues: OPENREVIEW_VENUES,
    });
    return { transport, adapter };
  }

  it('logs in and normalizes reviewer/area-chair assignments from edges + group membership', async () => {
    const { adapter, transport } = build();
    const res = await adapter.discover(TIER2B_QUERY);
    expect(res.errors).toEqual([]);
    expect(res.items).toHaveLength(3);

    const loginReq = transport.requests.find((r) => r.url.endsWith('/login'));
    expect(loginReq?.method).toBe('POST');
    expect(loginReq?.body).toContain('dara@loomwork.example');

    const edgeReq = transport.requests.find((r) => r.url.includes('/edges?invitation='));
    expect(edgeReq?.url).toContain(encodeURIComponent(DARA_VOSS_OPENREVIEW_PROFILE));

    const accepted = res.items.find((i) => i.externalId === 'or-assign-1');
    expect(accepted?.kind).toBe('review_assignment');
    expect(accepted?.meta).toMatchObject({ role: 'reviewer', venue: NEURIPS_VENUE, status: 'accepted' });

    const areaChair = res.items.find((i) => i.externalId === 'or-assign-3');
    expect(areaChair?.meta).toMatchObject({ role: 'area_chair', status: 'accepted' });
  });

  it('skips a venue/role with no assignment edges (ICML area chair)', async () => {
    const { adapter } = build();
    const res = await adapter.discover(TIER2B_QUERY);
    expect(res.items.find((i) => i.meta.venue === ICML_VENUE && i.meta.role === 'area_chair')).toBeUndefined();
  });

  it('normalizes a declined assignment to status declined via group membership (E62)', async () => {
    const { adapter } = build();
    const res = await adapter.discover(TIER2B_QUERY);
    const declined = res.items.find((i) => i.externalId === 'or-assign-2');
    expect(declined?.meta).toMatchObject({ status: 'declined', venue: ICML_VENUE });
  });

  it('never leaks credentials into errors or item text', async () => {
    const { adapter } = build();
    const res = await adapter.discover(TIER2B_QUERY);
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('s3cret-pw');
  });

  it('returns limited on a 429 from the groups endpoint', async () => {
    const { adapter } = build(OPENREVIEW_LIMITED_FIXTURES);
    const res = await adapter.discover(TIER2B_QUERY);
    expect(res.limited).toBe(true);
    expect(res.items).toEqual([]);
  });

  it('surfaces a login failure as an error, never throws', async () => {
    const transport = new FixtureTransport({
      'POST https://api2.openreview.net/login': { status: 401, headers: {}, body: JSON.stringify({ error: 'invalid credentials' }) },
    });
    const adapter = createOpenReviewAdapter({
      transport,
      username: 'dara@loomwork.example',
      password: 'wrong',
      profileId: DARA_VOSS_OPENREVIEW_PROFILE,
      venues: OPENREVIEW_VENUES,
    });
    const res = await adapter.discover(TIER2B_QUERY);
    expect(res.items).toEqual([]);
    expect(res.errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(res.errors)).not.toContain('wrong');
  });
});

describe('ORCID adapter', () => {
  function build(fixtures = ORCID_FIXTURES) {
    const transport = new FixtureTransport(fixtures);
    const adapter = createOrcidAdapter({ transport, orcidId: DARA_VOSS_ORCID, clientId: 'client-abc', clientSecret: 'shh-secret' });
    return { transport, adapter };
  }

  it('requests a client-credentials token with the read-public scope', async () => {
    const { adapter, transport } = build();
    await adapter.discover(TIER2B_QUERY);
    const tokenReq = transport.requests.find((r) => r.url === 'https://orcid.org/oauth/token');
    expect(tokenReq?.method).toBe('POST');
    expect(tokenReq?.body).toContain('scope=%2Fread-public');
    expect(tokenReq?.body).toContain('grant_type=client_credentials');
  });

  it('normalizes a work to kind work with doi and venue', async () => {
    const { adapter } = build();
    const res = await adapter.discover(TIER2B_QUERY);
    const work = res.items.find((i) => i.kind === 'work');
    expect(work?.meta).toMatchObject({ doi: '10.5555/loomwork.2025.001', venue: 'Workshop on Reliable ML (synthetic proceedings)' });
  });

  it('normalizes a completed peer review to an accepted review_assignment', async () => {
    const { adapter } = build();
    const res = await adapter.discover(TIER2B_QUERY);
    const review = res.items.find((i) => i.kind === 'review_assignment');
    expect(review?.meta).toMatchObject({ role: 'reviewer', status: 'accepted' });
  });

  it('never leaks the client secret', async () => {
    const { adapter } = build();
    const res = await adapter.discover(TIER2B_QUERY);
    expect(JSON.stringify(res)).not.toContain('shh-secret');
  });

  it('returns limited on a 429', async () => {
    const { adapter } = build(ORCID_LIMITED_FIXTURES);
    const res = await adapter.discover(TIER2B_QUERY);
    expect(res.limited).toBe(true);
  });
});

describe('SEC EDGAR adapter', () => {
  it('throws a configuration error at construction without a User-Agent', () => {
    const transport = new FixtureTransport({});
    expect(() => createEdgarAdapter({ transport, userAgent: '' })).toThrow();
  });

  it('throws a configuration error when the User-Agent has no email address', () => {
    const transport = new FixtureTransport({});
    expect(() => createEdgarAdapter({ transport, userAgent: 'Exhibit evidence agent' })).toThrow();
  });

  function build(fixtures = EDGAR_FIXTURES) {
    const transport = new FixtureTransport(fixtures);
    const adapter = createEdgarAdapter({ transport, userAgent: 'Exhibit evidence agent contact@example.com', requestDelayMs: 0 });
    return { transport, adapter };
  }

  it('sends the required User-Agent header', async () => {
    const { adapter, transport } = build();
    await adapter.discover(TIER2B_QUERY);
    for (const req of transport.requests) {
      expect(req.headers?.['user-agent']).toBe('Exhibit evidence agent contact@example.com');
    }
  });

  it('normalizes a Form D filing to kind filing with issuerName verbatim', async () => {
    const { adapter } = build();
    const res = await adapter.discover(TIER2B_QUERY);
    const loomwork = res.items.find((i) => (i.meta as { issuerName: string }).issuerName === 'Loomwork, Inc.');
    expect(loomwork?.kind).toBe('filing');
    expect(loomwork?.meta).toMatchObject({ formType: 'D', issuerName: 'Loomwork, Inc.', amountSold: 4_200_000, filedAt: '2025-11-04' });
    expect(loomwork?.text).toContain('Dara Voss');
  });

  it('normalizes the look-alike Form D verbatim, distinguishable by issuerName (E61)', async () => {
    const { adapter } = build();
    const res = await adapter.discover(TIER2B_QUERY);
    const lookalike = res.items.find((i) => (i.meta as { issuerName: string }).issuerName === 'Loomworks Capital LLC');
    expect(lookalike).toBeDefined();
    expect(lookalike?.meta).toMatchObject({ issuerName: 'Loomworks Capital LLC', relatedPersons: ['Priya Natarajan', 'Owen Whitfield'] });
    expect(lookalike?.text).not.toContain('Dara Voss');
  });

  it('returns limited on a 429 from full-text search', async () => {
    const { adapter } = build(EDGAR_LIMITED_FIXTURES);
    const res = await adapter.discover(TIER2B_QUERY);
    expect(res.limited).toBe(true);
    expect(res.items).toEqual([]);
  });
});
