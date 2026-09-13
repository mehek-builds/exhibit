import { createDiscoveryExtension } from '../../src/discovery/extension.js';
import { createGdeltAdapter } from '../../src/integrations/gdelt.js';
import { createHuggingFaceAdapter } from '../../src/integrations/huggingface.js';
import type { DiscoveredItem, DiscoveryAdapter, DiscoveryQuery, DiscoveryResult } from '../../src/integrations/types.js';
import { FixtureTransport } from '../../src/integrations/types.js';
import type { CandidateRow } from '../../src/ledger.js';
import type { ExhibitRecord, O1Criterion, Status } from '../../src/types.js';
import { DISCOVERY_TIER1_FIXTURES, GDELT_ARTICLES } from '../fixtures/discovery-tier1.js';
import type { GradeCheck, Scenario, ScenarioContext } from '../scenarios.js';
import { E, seed } from '../corpus.js';

// S21 (PRD 12.3, 6.14): discovery framework end to end. Recorded GDELT and Hugging Face responses
// (Tier 1, harness/fixtures/discovery-tier1.ts) plus an in-file fake Tier 2 adapter exercising the
// three PRD-listed extra shapes: a self-submitted Hacker News post, a Product Hunt badge, and a
// look-alike Form D that never names the founder (E61).

const LOOKALIKE_FORM_D_URL = 'https://www.sec.example/edgar/loomworks-capital-formd-2026';
const SELF_POST_URL = 'https://news.ycombinator.example/item?id=41000001';
const PH_BADGE_URL = 'https://www.producthunt.example/posts/loomwork-2026';

function chk(name: string, pass: boolean, detail: string): GradeCheck {
  return { name, pass, detail };
}

function splitSource(src: string): { app: string; id: string } {
  const i = src.indexOf(':');
  return { app: src.slice(0, i), id: src.slice(i + 1) };
}

function hasSource(sources: { app: string; id: string }[], src: string): boolean {
  const { app, id } = splitSource(src);
  return sources.some((s) => s.app === app && s.id === id);
}

function candidateByExactUrl(env: ScenarioContext['env'], url: string): CandidateRow | undefined {
  return env.ledger.candidates().find((c) => c.url === url);
}

function fakeTier2Adapter(): DiscoveryAdapter {
  return {
    info: {
      id: 'fake-tier2',
      name: 'Fake Tier 2 (test double: Hacker News + Product Hunt + EDGAR)',
      job: ['discover'],
      tier: 2,
      criteria: '#1, #5, #8',
      freeTier: 'n/a (test double)',
      credentials: [],
      receives: 'nothing; synthetic fixture only',
    },
    async discover(q: DiscoveryQuery): Promise<DiscoveryResult> {
      const selfPost: DiscoveredItem = {
        source: 'hackernews',
        externalId: '41000001',
        kind: 'launch',
        url: SELF_POST_URL,
        title: `Show HN: ${q.company} - a CI flakiness detector`,
        text: `Show HN: ${q.company} - a CI flakiness detector\nSubmitted by ${q.founderName} of ${q.company}.`,
        publishedAt: '2026-04-10T15:00:00.000Z',
        author: { name: q.founderName, handle: q.handles[0] },
        submittedByFounder: true,
        meta: {},
        raw: '{}',
      };
      const badge: DiscoveredItem = {
        source: 'producthunt',
        externalId: 'loomwork-2026',
        kind: 'badge',
        url: PH_BADGE_URL,
        title: `${q.company} is Product of the Day`,
        text: `${q.founderName}'s ${q.company} won Product of the Day.`,
        publishedAt: '2026-04-11T00:00:00.000Z',
        author: { name: q.founderName },
        meta: { badge: 'Product of the Day' },
        raw: '{}',
      };
      // Look-alike Form D for a differently-named entity, "Loomworks Capital LLC" (not the founder's
      // company, "Loomwork"), and never names the founder: fails the second-identifier rule (E61).
      const lookAlikeFormD: DiscoveredItem = {
        source: 'edgar',
        externalId: 'loomworks-capital-formd-2026',
        kind: 'filing',
        url: LOOKALIKE_FORM_D_URL,
        title: 'Form D: Loomworks Capital LLC',
        text: 'Form D filed by Loomworks Capital LLC, a private fund manager. No individuals named as executive officers in this excerpt.',
        publishedAt: '2026-04-12T00:00:00.000Z',
        author: {},
        meta: { formType: 'D', issuerName: 'Loomworks Capital LLC' },
        raw: '{}',
      };
      return { items: [selfPost, badge, lookAlikeFormD], errors: [] };
    },
  };
}

function seedS21() {
  return seed({ gmail: [...E.press] });
}

export const S21: Scenario = {
  id: 'S21',
  title: 'Discovery: GDELT, Hugging Face and Tier 2 sources',
  core: true,
  seed: seedS21,
  async play(ctx: ScenarioContext): Promise<void> {
    const transport = new FixtureTransport(DISCOVERY_TIER1_FIXTURES);
    const gdelt = createGdeltAdapter({ transport });
    const hf = createHuggingFaceAdapter({ transport });
    const fakeTier2 = fakeTier2Adapter();
    // env.deps is the same object closed over by env.run(): setting extensions here wires the
    // discovery hook into this run without any change to createHarnessEnv (see final report).
    ctx.env.deps.extensions = [createDiscoveryExtension({ adapters: [gdelt, hf, fakeTier2], alwaysRun: true, transportKind: 'fixture' })];
    await ctx.env.run();
  },
  grade(ctx: ScenarioContext): GradeCheck[] {
    const { env } = ctx;
    const checks: GradeCheck[] = [];

    // The new GDELT article is a #3 candidate.
    const newArticle = candidateByExactUrl(env, GDELT_ARTICLES.newFromGdelt.url);
    checks.push(chk('new GDELT article is a candidate', !!newArticle, GDELT_ARTICLES.newFromGdelt.url));
    if (newArticle) {
      checks.push(chk('new GDELT article maps to #3', (newArticle.criteria as O1Criterion[]).includes(3), `${newArticle.criteria}`));
    }

    // The inbox duplicate merges into one candidate with both sources.
    const dup = candidateByExactUrl(env, GDELT_ARTICLES.inboxDuplicate.url);
    checks.push(chk('duplicate article merged into one candidate', !!dup, GDELT_ARTICLES.inboxDuplicate.url));
    if (dup) {
      checks.push(chk('merged candidate has both sources', hasSource(dup.sources, 'gmail:m-press') && hasSource(dup.sources, 'discovery:gdelt:' + GDELT_ARTICLES.inboxDuplicate.url), JSON.stringify(dup.sources)));
      const exhibitsForKey = env.ledger.exhibits().filter((e: ExhibitRecord) => hasSource(e.sources, 'gmail:m-press'));
      checks.push(chk('exactly one exhibit for the duplicate', exhibitsForKey.length === 1, `${exhibitsForKey.length}`));
    }

    // The namesake article never became a candidate, and was logged as a second-identifier reject.
    const namesake = candidateByExactUrl(env, GDELT_ARTICLES.namesake.url);
    checks.push(chk('namesake article never became a candidate', !namesake, GDELT_ARTICLES.namesake.url));
    const namesakeEvents = env.ledger.events({ kind: 'discovery' }).filter((e) => (e.detail as { url?: string }).url === GDELT_ARTICLES.namesake.url);
    checks.push(chk('namesake logged as second_identifier_reject', namesakeEvents.some((e) => (e.detail as { outcome?: string }).outcome === 'second_identifier_reject'), JSON.stringify(namesakeEvents.map((e) => e.detail))));

    // The look-alike Form D never became a candidate either, same reason.
    const lookAlike = candidateByExactUrl(env, LOOKALIKE_FORM_D_URL);
    checks.push(chk('look-alike Form D never became a candidate', !lookAlike, LOOKALIKE_FORM_D_URL));
    const formDEvents = env.ledger.events({ kind: 'discovery' }).filter((e) => (e.detail as { url?: string }).url === LOOKALIKE_FORM_D_URL);
    checks.push(chk('look-alike Form D logged as second_identifier_reject', formDEvents.some((e) => (e.detail as { outcome?: string }).outcome === 'second_identifier_reject'), JSON.stringify(formDEvents.map((e) => e.detail))));

    // The self-submitted Hacker News post is never #3 and is #5 building.
    const selfPost = candidateByExactUrl(env, SELF_POST_URL);
    checks.push(chk('self-submitted HN post is a candidate', !!selfPost, SELF_POST_URL));
    if (selfPost) {
      checks.push(chk('self-submitted HN post never #3', !(selfPost.criteria as O1Criterion[]).includes(3), `${selfPost.criteria}`));
      checks.push(chk('self-submitted HN post is #5 building', (selfPost.criteria as O1Criterion[]).includes(5) && (selfPost.status as Status) === 'building', `${selfPost.criteria} ${selfPost.status}`));
    }

    // The Product Hunt badge is #1 needs_attorney.
    const badge = candidateByExactUrl(env, PH_BADGE_URL);
    checks.push(chk('Product Hunt badge is a candidate', !!badge, PH_BADGE_URL));
    if (badge) {
      checks.push(chk('badge is #1 needs_attorney', (badge.criteria as O1Criterion[]).includes(1) && (badge.status as Status) === 'needs_attorney', `${badge.criteria} ${badge.status}`));
    }

    // The Hugging Face model is #5 qualifying (25,000 downloads, above the 10,000 threshold).
    const hfModel = env.ledger.candidates().find((c) => c.url?.includes('huggingface.co/loomwork/flaky-ci-classifier'));
    checks.push(chk('Hugging Face model is a candidate', !!hfModel, 'huggingface.co/loomwork/flaky-ci-classifier'));
    if (hfModel) {
      checks.push(chk('HF model is #5 qualifying', (hfModel.criteria as O1Criterion[]).includes(5) && (hfModel.status as Status) === 'qualifying', `${hfModel.criteria} ${hfModel.status}`));
    }

    return checks;
  },
};
