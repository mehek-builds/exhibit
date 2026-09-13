import type { FixtureMap } from '../../src/integrations/types.js';

// Synthetic fixtures for the Tier 2a discovery adapters (PRD 6.14, S21): Hacker News, Product Hunt,
// Podcast Index, USPTO. All data is fictional — the founder is "Dara Voss" of "Loomwork"
// (loomwork.example, handle dvoss). One namesake record per source where it makes sense, plus one
// 429 (limited) fixture per source.

const HN_SHOW_HN = {
  objectID: 'hn-1001',
  title: 'Show HN: Loomwork – a build tool for AI infra teams',
  story_text: 'I built Loomwork to make deploys boring again. Feedback welcome.',
  comment_text: null,
  url: 'https://loomwork.example/launch',
  author: 'dvoss',
  points: 142,
  num_comments: 38,
  created_at: '2026-02-10T15:00:00.000Z',
};

const HN_THIRD_PARTY_STORY = {
  objectID: 'hn-1002',
  title: 'Loomwork is quietly becoming the default for AI infra teams',
  story_text: 'A profile of Dara Voss and how Loomwork grew from a side project.',
  comment_text: null,
  url: 'https://techdigest.example/loomwork-profile',
  author: 'quietwatcher',
  points: 88,
  num_comments: 21,
  created_at: '2026-04-05T09:30:00.000Z',
};

const HN_NAMESAKE_STORY = {
  objectID: 'hn-1003',
  title: 'Show HN: DaraCam, a photo app for hikers',
  story_text: 'Built by another Dara Voss, no relation, for hiking photography.',
  comment_text: null,
  url: 'https://daracam.example',
  author: 'daravoss99',
  points: 12,
  num_comments: 3,
  created_at: '2026-05-01T10:00:00.000Z',
};

export const HN_FIXTURES: FixtureMap = {
  'GET https://hn.algolia.com/api/v1/search': (req) => {
    const url = new URL(req.url);
    const query = url.searchParams.get('query') ?? '';
    if (/429/i.test(query)) return { status: 429, headers: {} as Record<string, string>, body: JSON.stringify({ error: 'rate limit exceeded' }) };
    if (/loomwork/i.test(query)) {
      return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hits: [HN_SHOW_HN, HN_THIRD_PARTY_STORY] }) };
    }
    if (/dara voss/i.test(query)) {
      return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hits: [HN_NAMESAKE_STORY] }) };
    }
    return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hits: [] }) };
  },
};

const PH_LAUNCH_POST = {
  id: 'ph-500',
  name: 'Loomwork',
  tagline: 'Deploys that get out of your way',
  description: 'Loomwork is a build and deploy tool for AI infrastructure teams.',
  url: 'https://www.producthunt.com/posts/loomwork',
  website: 'https://loomwork.example',
  votesCount: 612,
  createdAt: '2026-03-01T08:00:00.000Z',
  user: { username: 'dvoss', name: 'Dara Voss' },
  badges: [{ type: 'Product of the Day' }],
};

const PH_NAMESAKE_POST = {
  id: 'ph-501',
  name: 'DaraCam',
  tagline: 'A photo app for hikers',
  description: 'By a different Dara Voss.',
  url: 'https://www.producthunt.com/posts/daracam',
  website: 'https://daracam.example',
  votesCount: 40,
  createdAt: '2026-05-02T08:00:00.000Z',
  user: { username: 'daravoss99', name: 'Dara Voss' },
  badges: [],
};

export const PRODUCTHUNT_FIXTURES: FixtureMap = {
  'POST https://api.producthunt.com/v2/api/graphql': (req) => {
    const body = typeof req.body === 'string' ? req.body : '';
    if (/429trigger/i.test(body)) {
      return { status: 200, headers: {} as Record<string, string>, body: JSON.stringify({ errors: [{ message: 'rate limit exceeded, try again later' }] }) };
    }
    if (/loomwork/i.test(body)) {
      return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: { posts: { edges: [{ node: PH_LAUNCH_POST }] } } }) };
    }
    if (/dara voss/i.test(body)) {
      return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: { posts: { edges: [{ node: PH_NAMESAKE_POST }] } } }) };
    }
    return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: { posts: { edges: [] } } }) };
  },
};

const PODCAST_EPISODE_DARA_GUEST = {
  id: 9001,
  title: 'Building infra that gets out of your way, with Dara Voss',
  description: 'Dara Voss of Loomwork joins to talk about developer tooling for AI infra teams.',
  link: 'https://podcasts.example/infra-weekly/ep-42',
  enclosureUrl: 'https://cdn.podcasts.example/infra-weekly/ep-42.mp3',
  feedTitle: 'Infra Weekly',
  feedUrl: 'https://podcasts.example/infra-weekly/feed.xml',
  datePublished: Math.floor(new Date('2026-04-20T12:00:00.000Z').getTime() / 1000),
};

const PODCAST_EPISODE_NAMESAKE = {
  id: 9002,
  title: 'Trail photography tips with Dara Voss',
  description: 'A different Dara Voss talks hiking photography, no relation to Loomwork.',
  link: 'https://podcasts.example/outdoor-cast/ep-7',
  enclosureUrl: 'https://cdn.podcasts.example/outdoor-cast/ep-7.mp3',
  feedTitle: 'Outdoor Cast',
  feedUrl: 'https://podcasts.example/outdoor-cast/feed.xml',
  datePublished: Math.floor(new Date('2026-05-10T12:00:00.000Z').getTime() / 1000),
};

export const PODCASTINDEX_FIXTURES: FixtureMap = {
  'GET https://api.podcastindex.org/api/1.0/search/byperson': (req) => {
    const url = new URL(req.url);
    const q = url.searchParams.get('q') ?? '';
    if (!req.headers?.['X-Auth-Key'] || !req.headers?.['Authorization']) {
      return { status: 401, headers: {} as Record<string, string>, body: JSON.stringify({ status: 'false', description: 'missing auth' }) };
    }
    if (/429/i.test(q)) return { status: 429, headers: {} as Record<string, string>, body: JSON.stringify({ status: 'false', description: 'rate limited' }) };
    if (/dara voss/i.test(q)) {
      return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'true', items: [PODCAST_EPISODE_DARA_GUEST, PODCAST_EPISODE_NAMESAKE] }) };
    }
    return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'true', items: [] }) };
  },
};

const PATENT_APPLICATION_LOOMWORK = {
  patent_id: '11234567',
  patent_title: 'Method and system for declarative build orchestration',
  patent_abstract: 'A system for declaratively orchestrating build pipelines for distributed AI infrastructure.',
  patent_date: '2026-06-15',
  inventors: [{ inventor_name_first: 'Dara', inventor_name_last: 'Voss' }],
  assignees: [{ assignee_organization: 'Loomwork, Inc.' }],
};

const PATENT_NAMESAKE = {
  patent_id: '10999999',
  patent_title: 'Trekking pole with integrated camera mount',
  patent_abstract: 'A trekking pole with a mount for an action camera.',
  patent_date: '2026-01-05',
  inventors: [{ inventor_name_first: 'Dara', inventor_name_last: 'Voss' }],
  assignees: [{ assignee_organization: 'TrailGear LLC' }],
};

export const USPTO_FIXTURES: FixtureMap = {
  'GET https://search.patentsview.org/api/v1/patent/': (req) => {
    const url = new URL(req.url);
    const q = url.searchParams.get('q') ?? '';
    if (!req.headers?.['X-Api-Key']) return { status: 401, headers: {} as Record<string, string>, body: JSON.stringify({ error: true, message: 'missing api key' }) };
    if (/429trigger/i.test(q)) return { status: 429, headers: {} as Record<string, string>, body: JSON.stringify({ error: true, message: 'rate limited' }) };
    if (/inventor_name_last":"Voss"/i.test(q)) {
      // The fixture cannot distinguish "founder" from "namesake" by query alone (both search
      // inventor last name "Voss"), so both records return together; the test's since-date filter
      // and the second-identifier rule (owned by the discovery extension) separate them.
      return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ patents: [PATENT_APPLICATION_LOOMWORK, PATENT_NAMESAKE], count: 2 }) };
    }
    return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ patents: [], count: 0 }) };
  },
};

export const DISCOVERY_TIER2A_FIXTURES: FixtureMap = {
  ...HN_FIXTURES,
  ...PRODUCTHUNT_FIXTURES,
  ...PODCASTINDEX_FIXTURES,
  ...USPTO_FIXTURES,
};
