import type { FixtureMap } from '../../src/integrations/types.js';

// Synthetic fixtures for the verifier API adapters (PRD 6.11, 6.14, 12.3). Every numeric value
// here is a synthetic fixture value, not the published BLS/O*NET/GitHub/ecosyste.ms figure, and is
// keyed to the fictional loomwork/flakehound repo and "Dara Voss" corpus in harness/corpus.ts.

// ---- GitHub + ecosyste.ms: loomwork/flakehound (matches harness/corpus.ts REPOS.loomwork) ----

export const GITHUB_STARS = 2340;
export const GITHUB_FORKS = 188;
export const ECOSYSTEMS_STARS = 2338; // within 25% of GITHUB_STARS — agrees

const githubRepoBody = JSON.stringify({
  full_name: 'loomwork/flakehound',
  stargazers_count: GITHUB_STARS,
  forks_count: GITHUB_FORKS,
  pushed_at: '2026-09-10T00:00:00Z',
});

// No `dependents_count` field here: the repos.ecosyste.ms `Repository` schema does not define one
// (confirmed against https://raw.githubusercontent.com/ecosyste-ms/repos/main/openapi/api/v1/openapi.yaml
// — see src/integrations/ecosystems.ts).
const ecosystemsRepoBody = JSON.stringify({
  full_name: 'loomwork/flakehound',
  stargazers_count: ECOSYSTEMS_STARS,
  updated_at: '2026-09-11T00:00:00Z',
});

// ---- Crossref / OpenAlex / Semantic Scholar: fictional DOI, agreeing citation counts ----

export const FICTIONAL_DOI = '10.9999/flakehound-synthetic.2026';
export const CITATION_COUNT_CROSSREF = 42;
export const CITATION_COUNT_OPENALEX = 44; // within 25% of 42 — agrees
export const CITATION_COUNT_S2 = 43;

const crossrefBody = JSON.stringify({ message: { 'is-referenced-by-count': CITATION_COUNT_CROSSREF, publisher: 'Synthetic Press', deposited: { 'date-time': '2026-08-01T00:00:00Z' } } });
const openAlexBody = JSON.stringify({ cited_by_count: CITATION_COUNT_OPENALEX, doi: FICTIONAL_DOI, updated_date: '2026-08-15T00:00:00Z' });
const s2Body = JSON.stringify({ citationCount: CITATION_COUNT_S2, influentialCitationCount: 6 });

// ---- BLS + O*NET: SOC 11-1011 ("Chief Executives"), synthetic wage figures agreeing within 25% ----

export const BLS_P90_WAGE = 240_000; // synthetic fixture value, not the published BLS figure
export const ONET_P90_WAGE = 208_000; // synthetic fixture value, not the published O*NET figure — within 25%

const blsSeriesBody = JSON.stringify({
  status: 'REQUEST_SUCCEEDED',
  Results: { series: [{ seriesID: 'OEUN000000000000110000000015', data: [{ year: '2026', period: 'A01', value: String(BLS_P90_WAGE) }] }] },
});

const onetWagesBody = JSON.stringify({ occupation_code: '11-1011.00', annual_wages: { percentile_90: ONET_P90_WAGE } });

// ---- OpenAlex 429: a second, distinct fictional DOI whose daily allowance is spent (E68) ----

export const LIMITED_DOI = '10.9999/limited-synthetic.2026';

export const VERIFIER_API_FIXTURES: FixtureMap = {
  'GET https://api.github.com/repos/loomwork/flakehound': { status: 200, headers: { 'content-type': 'application/json' }, body: githubRepoBody },
  'GET https://repos.ecosyste.ms/api/v1/hosts/GitHub/repositories/loomwork/flakehound': { status: 200, headers: { 'content-type': 'application/json' }, body: ecosystemsRepoBody },

  [`GET https://api.crossref.org/works/${encodeURIComponent(FICTIONAL_DOI)}`]: { status: 200, headers: { 'content-type': 'application/json' }, body: crossrefBody },
  [`GET https://api.openalex.org/works/doi:${encodeURIComponent(FICTIONAL_DOI)}`]: { status: 200, headers: { 'content-type': 'application/json' }, body: openAlexBody },
  [`GET https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(FICTIONAL_DOI)}`]: { status: 200, headers: { 'content-type': 'application/json' }, body: s2Body },

  [`GET https://api.openalex.org/works/doi:${encodeURIComponent(LIMITED_DOI)}`]: { status: 429, headers: {}, body: JSON.stringify({ error: 'daily allowance exceeded' }) },

  'POST https://api.bls.gov/publicAPI/v2/timeseries/data/': { status: 200, headers: { 'content-type': 'application/json' }, body: blsSeriesBody },
  'GET https://api-v2.onetcenter.org/online/occupations/11-1011.00/summary/wages': { status: 200, headers: { 'content-type': 'application/json' }, body: onetWagesBody },
};
