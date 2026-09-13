import type { FixtureMap } from '../../src/integrations/types.js';

// Synthetic recorded responses for the Tier 1 discovery sources (PRD 6.14, S21). Everything here is
// fictional: .example outlets and the fictional founder Dara Voss. Used by test/discovery.test.ts and
// harness/scenarios/s21.ts through FixtureTransport, which matches a request by its URL with the query
// string stripped, so one entry covers every query GDELT or Hugging Face is asked in a run.

const DEVTOOLSWEEKLY_URL = 'https://devtoolsweekly.example/2026/03/loomwork-dara-voss-flaky-ci';
const TECHWIRE_URL = 'https://techwire.example/2026/04/loomwork-dara-voss-ai-infra';
const LISBON_CHEF_URL = 'https://tastelisbon.example/2026/02/chef-dara-voss-tasca';

export const GDELT_ARTICLES = {
  inboxDuplicate: {
    url: DEVTOOLSWEEKLY_URL,
    title: "Loomwork's Dara Voss wants to end flaky CI",
    seendate: '20260318T140000Z',
    domain: 'devtoolsweekly.example',
  },
  newFromGdelt: {
    url: TECHWIRE_URL,
    title: 'Dara Voss of Loomwork raises the bar for AI infrastructure',
    seendate: '20260405T090000Z',
    domain: 'techwire.example',
  },
  namesake: {
    url: LISBON_CHEF_URL,
    title: 'Dara Voss, the Lisbon chef reinventing the tasca',
    seendate: '20260210T110000Z',
    domain: 'tastelisbon.example',
  },
};

const GDELT_RESPONSE = {
  articles: [GDELT_ARTICLES.inboxDuplicate, GDELT_ARTICLES.newFromGdelt, GDELT_ARTICLES.namesake],
};

export const HUGGINGFACE_MODEL = {
  id: 'loomwork/flaky-ci-classifier',
  author: 'loomwork',
  downloads: 25_000,
  likes: 143,
  createdAt: '2026-01-15T00:00:00.000Z',
};

const HF_MODELS_RESPONSE = [HUGGINGFACE_MODEL];
const HF_DATASETS_RESPONSE: unknown[] = [];

export const DISCOVERY_TIER1_FIXTURES: FixtureMap = {
  'GET https://api.gdeltproject.org/api/v2/doc/doc': { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(GDELT_RESPONSE) },
  'GET https://huggingface.co/api/models': { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(HF_MODELS_RESPONSE) },
  'GET https://huggingface.co/api/datasets': { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(HF_DATASETS_RESPONSE) },
};
