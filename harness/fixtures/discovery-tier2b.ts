import type { FixtureMap } from '../../src/integrations/types.js';

// Synthetic fixtures for the Tier 2 discovery adapters (PRD 6.14): OpenReview, ORCID, SEC EDGAR.
// Founder "Dara Voss", company "Loomwork, Inc." (loomwork.example), co-author "Ren Park". All
// data below is fictional and labeled synthetic.

const OPENREVIEW_BASE = 'https://api2.openreview.net';
const ORCID_API_BASE = 'https://pub.orcid.org/v3.0';
const ORCID_TOKEN_URL = 'https://orcid.org/oauth/token';
const EDGAR_SEARCH_URL = 'https://efts.sec.gov/LATEST/search-index';

export const DARA_VOSS_ORCID = '0009-0001-2345-6789';

export const DARA_VOSS_OPENREVIEW_PROFILE = '~Dara_Voss1';
export const NEURIPS_VENUE = 'NeurIPS 2025 Workshop on Reliable ML';
export const ICML_VENUE = 'ICML 2025 Workshop on Agents';
export const OPENREVIEW_VENUES = [NEURIPS_VENUE, ICML_VENUE];

function edgesUrl(venue: string, suffix: 'Reviewers' | 'Area_Chairs'): string {
  const invitation = `${venue}/${suffix}/-/Assignment`;
  return `${OPENREVIEW_BASE}/edges?invitation=${encodeURIComponent(invitation)}&tail=${encodeURIComponent(DARA_VOSS_OPENREVIEW_PROFILE)}`;
}

const GROUPS_URL = `${OPENREVIEW_BASE}/groups?member=${encodeURIComponent(DARA_VOSS_OPENREVIEW_PROFILE)}`;

export const OPENREVIEW_FIXTURES: FixtureMap = {
  [`POST ${OPENREVIEW_BASE}/login`]: {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'synthetic-openreview-token-daravoss' }),
  },
  // Group membership decides accepted vs declined: accepted for NeurIPS reviewer + area chair,
  // declined for the ICML reviewer invite (E62).
  [`GET ${GROUPS_URL}`]: {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      groups: [
        { id: `${NEURIPS_VENUE}/Reviewers` },
        { id: `${NEURIPS_VENUE}/Area_Chairs` },
        { id: `${ICML_VENUE}/Reviewers/Declined` },
      ],
    }),
  },
  [`GET ${edgesUrl(NEURIPS_VENUE, 'Reviewers')}`]: {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ edges: [{ id: 'or-assign-1', head: 'paper-1', tail: DARA_VOSS_OPENREVIEW_PROFILE, cdate: Date.parse('2025-08-01T00:00:00.000Z') }] }),
  },
  [`GET ${edgesUrl(NEURIPS_VENUE, 'Area_Chairs')}`]: {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ edges: [{ id: 'or-assign-3', head: 'paper-2', tail: DARA_VOSS_OPENREVIEW_PROFILE, cdate: Date.parse('2025-07-15T00:00:00.000Z') }] }),
  },
  [`GET ${edgesUrl(ICML_VENUE, 'Reviewers')}`]: {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ edges: [{ id: 'or-assign-2', head: 'paper-3', tail: DARA_VOSS_OPENREVIEW_PROFILE, cdate: Date.parse('2025-03-10T00:00:00.000Z') }] }),
  },
  [`GET ${edgesUrl(ICML_VENUE, 'Area_Chairs')}`]: {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ edges: [] }),
  },
};

// Same shape, but the login succeeds and the groups call is rate-limited (E68).
export const OPENREVIEW_LIMITED_FIXTURES: FixtureMap = {
  [`POST ${OPENREVIEW_BASE}/login`]: OPENREVIEW_FIXTURES[`POST ${OPENREVIEW_BASE}/login`]!,
  [`GET ${GROUPS_URL}`]: { status: 429, headers: {}, body: JSON.stringify({ error: 'rate limited' }) },
};

export const ORCID_FIXTURES: FixtureMap = {
  [`POST ${ORCID_TOKEN_URL}`]: {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ access_token: 'synthetic-orcid-token', token_type: 'bearer', expires_in: 631138518, scope: '/read-public' }),
  },
  [`GET ${ORCID_API_BASE}/${DARA_VOSS_ORCID}/works`]: {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      group: [
        {
          'work-summary': [
            {
              'put-code': 1001,
              title: { title: { value: 'Reliable Tool Use in Long-Horizon Agents' } },
              'journal-title': { value: 'Workshop on Reliable ML (synthetic proceedings)' },
              'external-ids': { 'external-id': [{ 'external-id-type': 'doi', 'external-id-value': '10.5555/loomwork.2025.001' }] },
              'publication-date': { year: { value: '2025' }, month: { value: '09' }, day: { value: '12' } },
            },
          ],
        },
      ],
    }),
  },
  [`GET ${ORCID_API_BASE}/${DARA_VOSS_ORCID}/peer-reviews`]: {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      group: [
        {
          'peer-review-group': [
            {
              'peer-review-summary': [
                {
                  'put-code': 2001,
                  'review-group-id': 'issn:9999-0001',
                  'convening-organization': { name: 'Workshop on Reliable ML (synthetic)' },
                  'completion-date': { year: { value: '2025' }, month: { value: '10' }, day: { value: '01' } },
                },
              ],
            },
          ],
        },
      ],
    }),
  },
};

export const ORCID_LIMITED_FIXTURES: FixtureMap = {
  [`POST ${ORCID_TOKEN_URL}`]: ORCID_FIXTURES[`POST ${ORCID_TOKEN_URL}`]!,
  [`GET ${ORCID_API_BASE}/${DARA_VOSS_ORCID}/works`]: { status: 429, headers: {}, body: JSON.stringify({ error: 'rate limited' }) },
  [`GET ${ORCID_API_BASE}/${DARA_VOSS_ORCID}/peer-reviews`]: { status: 429, headers: {}, body: JSON.stringify({ error: 'rate limited' }) },
};

const SEARCH_QUERY_URL = `${EDGAR_SEARCH_URL}?q=%22Loomwork%2C%20Inc.%22&forms=D`;

const LOOMWORK_CIK = '1999999';
const LOOMWORK_ADSH = '0001999999-25-000123';
const LOOKALIKE_CIK = '1888888';
const LOOKALIKE_ADSH = '0001888888-25-000456';

const LOOMWORK_PRIMARY_DOC_XML = `<?xml version="1.0"?>
<edgarSubmission>
  <primaryIssuer>
    <issuerName>Loomwork, Inc.</issuerName>
  </primaryIssuer>
  <offeringData>
    <dateOfFirstSale><value>2025-11-04</value></dateOfFirstSale>
    <totalAmountSold>4200000</totalAmountSold>
  </offeringData>
  <relatedPersonsList>
    <relatedPersonInfo>
      <relatedPersonName>
        <firstName>Dara</firstName>
        <lastName>Voss</lastName>
      </relatedPersonName>
    </relatedPersonInfo>
  </relatedPersonsList>
</edgarSubmission>`;

const LOOKALIKE_PRIMARY_DOC_XML = `<?xml version="1.0"?>
<edgarSubmission>
  <primaryIssuer>
    <issuerName>Loomworks Capital LLC</issuerName>
  </primaryIssuer>
  <offeringData>
    <dateOfFirstSale><value>2025-06-20</value></dateOfFirstSale>
    <totalAmountSold>900000</totalAmountSold>
  </offeringData>
  <relatedPersonsList>
    <relatedPersonInfo>
      <relatedPersonName>
        <firstName>Priya</firstName>
        <lastName>Natarajan</lastName>
      </relatedPersonName>
    </relatedPersonInfo>
    <relatedPersonInfo>
      <relatedPersonName>
        <firstName>Owen</firstName>
        <lastName>Whitfield</lastName>
      </relatedPersonName>
    </relatedPersonInfo>
  </relatedPersonsList>
</edgarSubmission>`;

export const EDGAR_FIXTURES: FixtureMap = {
  [`GET ${SEARCH_QUERY_URL}`]: {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      hits: {
        hits: [
          {
            _id: LOOMWORK_ADSH,
            _source: { ciks: [LOOMWORK_CIK], adsh: LOOMWORK_ADSH, display_names: ['LOOMWORK, INC. (CIK 0001999999)'], file_date: '2025-11-04', root_forms: ['D'] },
          },
          {
            _id: LOOKALIKE_ADSH,
            _source: { ciks: [LOOKALIKE_CIK], adsh: LOOKALIKE_ADSH, display_names: ['LOOMWORKS CAPITAL LLC (CIK 0001888888)'], file_date: '2025-06-20', root_forms: ['D'] },
          },
        ],
      },
    }),
  },
  [`GET https://www.sec.gov/Archives/edgar/data/${LOOMWORK_CIK}/${LOOMWORK_ADSH.replace(/-/g, '')}/primary_doc.xml`]: {
    status: 200,
    headers: { 'content-type': 'application/xml' },
    body: LOOMWORK_PRIMARY_DOC_XML,
  },
  // Look-alike company: unrelated related persons, kept verbatim (E61).
  [`GET https://www.sec.gov/Archives/edgar/data/${LOOKALIKE_CIK}/${LOOKALIKE_ADSH.replace(/-/g, '')}/primary_doc.xml`]: {
    status: 200,
    headers: { 'content-type': 'application/xml' },
    body: LOOKALIKE_PRIMARY_DOC_XML,
  },
};

// The synthetic founder's profile names the company "Loomwork" (harness/corpus.ts), so the adapter's
// quoted query omits ", Inc."; the same synthetic search response answers both spellings.
const SEARCH_QUERY_URL_PROFILE = `${EDGAR_SEARCH_URL}?q=%22Loomwork%22&forms=D`;
EDGAR_FIXTURES[`GET ${SEARCH_QUERY_URL_PROFILE}`] = EDGAR_FIXTURES[`GET ${SEARCH_QUERY_URL}`]!;

export const EDGAR_LIMITED_FIXTURES: FixtureMap = {
  [`GET ${SEARCH_QUERY_URL}`]: { status: 429, headers: {}, body: JSON.stringify({ error: 'rate limited' }) },
};

export const TIER2B_QUERY = {
  founderName: 'Dara Voss',
  aliases: [] as string[],
  company: 'Loomwork, Inc.',
  companyDomain: 'loomwork.example',
  handles: ['daravoss'],
  coauthors: ['Ren Park'],
  since: '2023-01-01',
};
