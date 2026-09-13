import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Arga is down for this whole file: constructing its client throws. Every harness run below must
// still work, which is PRD 10's "Arga: live mode unaffected" row applied to the entire suite.
vi.mock('arga-sdk', () => ({
  Arga: class {
    constructor() {
      throw new Error('Arga unavailable (injected fault)');
    }
  },
}));

import type { TwinOp } from '../src/twins/memory.js';
import { createDiscoveryExtension } from '../src/discovery/extension.js';
import { createBlsAdapter } from '../src/integrations/bls.js';
import { createGdeltAdapter } from '../src/integrations/gdelt.js';
import { createHuggingFaceAdapter } from '../src/integrations/huggingface.js';
import { createOnetAdapter } from '../src/integrations/onet.js';
import type { DiscoveredItem, DiscoveryAdapter, DiscoveryQuery } from '../src/integrations/types.js';
import { FixtureTransport } from '../src/integrations/types.js';
import { createIntegrityExtension } from '../src/integrity/extension.js';
import { letterId } from '../src/letters/letters.js';
import { createSigningExtension } from '../src/letters/signing.js';
import { HeuristicModel } from '../src/models/heuristic.js';
import { createNotifier } from '../src/notify/notifier.js';
import { FixtureFetcher, FixtureResearcher } from '../src/research/fixture.js';
import { createStructuredResearch } from '../src/research/structured.js';
import type { ResearchRequest } from '../src/research/types.js';
import { affected, validateGraph } from '../src/rules/graph.js';
import { createTextChannel } from '../src/text/channel.js';
import { HeuristicCommandParser } from '../src/text/commands.js';
import { MemoryDropboxSign } from '../src/twins/fakes.js';
import type { FounderProfile } from '../src/types.js';
import { DARA, E, NOW, fullYearSeed, seed } from '../harness/corpus.js';
import { createHarnessEnv, graph } from '../harness/env.js';
import type { HarnessEnv, HarnessEnvOptions } from '../harness/env.js';
import {
  failingApp,
  failingDropboxSign,
  failingFetcher,
  failingModel,
  failingResearcher,
  failingStructured,
  failingTransport,
  failingTwilio,
  spyResearcher,
  tryRun,
  unavailableGate,
} from '../harness/faults.js';
import { DISCOVERY_TIER1_FIXTURES, GDELT_ARTICLES } from '../harness/fixtures/discovery-tier1.js';
import { WEB_FIXTURES } from '../harness/fixtures.js';
import { createIntegrityFixtures } from '../harness/fixtures/integrity.js';
import { VERIFIER_API_FIXTURES } from '../harness/fixtures/verifier-apis.js';
import { prohibitedSideEffects } from '../harness/grade.js';

// PRD section 10, one describe per row: for each dependency that goes down, what Exhibit still
// does and what it stops doing -- and that it never silently substitutes for the missing dependency.
// Every test grades from twin ops, twin state and the ledger, and every test asserts that the
// degraded run performed no prohibited side effect (section 8).
//
// `it.fails` marks a confirmed defect: the test asserts the PRD 10 behavior, and the code does not
// do it yet. Never weaken one of those assertions; fix the code, and the `.fails` must come off.
// As of this pass, no `it.fails` remain in this file -- every PRD 10 row below is asserted as a
// normal (passing) test. Keep this comment in sync: if a future change reopens one of these
// defects, re-add `it.fails` on that test and list it here again with its confirmed code location.

const OWNER = DARA.emails[0]!;
const PRIYA = DARA.recommenderCandidates.find((r) => r.email === 'priya@buildnight.example')!;
const PROFILE_NONE: FounderProfile = { ...DARA, recommenderCandidates: [] };
const PROFILE_PRIYA: FounderProfile = { ...DARA, recommenderCandidates: [PRIYA] };

const envs: HarnessEnv[] = [];
function mk(o: HarnessEnvOptions): HarnessEnv {
  const env = createHarnessEnv({ gate: 'library', ...o });
  envs.push(env);
  return env;
}
afterEach(async () => {
  for (const env of envs.splice(0)) await env.close().catch(() => undefined);
});

function noProhibitedSideEffects(env: HarnessEnv): void {
  expect(prohibitedSideEffects(env)).toEqual([]);
}

function agentOps(env: HarnessEnv, app: string, op?: string): TwinOp[] {
  return env.twins.ops.filter((o) => o.actor === 'agent' && o.app === app && (!op || o.op === op));
}

function sendsToOthers(env: HarnessEnv): TwinOp[] {
  return agentOps(env, 'gmail', 'messages.send').filter((o) => ((o.detail.to as string[]) ?? []).some((t) => t.toLowerCase() !== OWNER));
}

function scorecardText(env: HarnessEnv): string {
  return env.twins.state().docs.find((d) => d.title === 'Exhibit scorecard')?.text ?? '';
}

function hasSource(sources: { app: string; id: string }[], src: string): boolean {
  const i = src.indexOf(':');
  return sources.some((s) => s.app === src.slice(0, i) && s.id === src.slice(i + 1));
}

function candidateBySource(env: HarnessEnv, src: string) {
  return env.ledger.candidates().find((c) => hasSource(c.sources, src));
}

function exhibitBySource(env: HarnessEnv, src: string) {
  return env.ledger.exhibits().find((e) => hasSource(e.sources, src));
}

function contextNotes(env: HarnessEnv) {
  return env.twins.state().drive.files.filter((f) => f.name === 'context-notes.md');
}

function approveInSheet(env: HarnessEnv, figId: string): void {
  const sheetId = env.ledger.get('review_sheet');
  if (!sheetId) throw new Error('no review sheet');
  env.twins.adminSetSheetCell(sheetId, { column: 'ID', equals: figId }, 'Decision', 'Approve');
}

function founderReply(env: HarnessEnv, subject: string, body: string, offsetMs = 60_000, extra: { threadId?: string; from?: string } = {}): void {
  env.twins.adminAddMessage({ from: extra.from ?? `Dara Voss <${OWNER}>`, to: [OWNER], threadId: extra.threadId, date: new Date(env.clock.now().getTime() + offsetMs).toUTCString(), subject, body });
}

/** A corpus whose press, podcast and accelerator exhibits get context figures from the web fixtures. */
const figureSeed = () => seed({ gmail: [...E.press, ...E.podcast, ...E.accelerator] });

// =====================================================================================
describe('PRD 10 row: Anthropic API down', () => {
  const modelSeed = () => seed({ gmail: [...E.press, ...E.accelerator, ...E.award] });

  it('still does intake, dedupe and the pre-filter', async () => {
    const env = mk({ seed: modelSeed(), profile: PROFILE_NONE, model: failingModel() });
    env.deps.researcher = failingResearcher('throw');

    const r1 = await env.run();
    expect(r1.outcome).toBe('ok');
    expect(agentOps(env, 'gmail', 'messages.list').length).toBeGreaterThan(0);
    expect(r1.itemsRead).toBeGreaterThan(0);

    // The pre-filter decides without the model, and its decisions are final.
    const drops = env.tracer.events().filter((e) => e.type === 'span' && e.name === 'prefilter.drop');
    expect(drops.length).toBeGreaterThan(0);
    for (const d of drops) {
      const { app, id } = d.input as { app: string; id: string };
      expect(env.ledger.itemSeen(app, id)?.stage).toBe('done');
    }

    // Dedupe: the next run re-reads only what is still queued, never the pre-filtered items.
    for (const id of ['m-press', 'm-accel', 'm-award']) expect(env.ledger.itemSeen('gmail', id)?.stage).toBe('retry');
    const r2 = await env.run();
    expect(r2.itemsRead).toBeLessThan(r1.itemsRead);
    expect(r2.itemsRead).toBeGreaterThanOrEqual(3);
    noProhibitedSideEffects(env);
  });

  it('stops classifying, mapping and corroborating; items queue and are processed once it recovers', async () => {
    const model = failingModel();
    const researcher = failingResearcher('throw');
    const env = mk({ seed: modelSeed(), profile: PROFILE_NONE, model });
    env.deps.researcher = researcher;

    const r1 = await env.run();
    expect(model.calls).toBeGreaterThan(0);
    expect(r1.modelCalls).toBe(0);
    expect(env.tracer.events().filter((e) => e.type === 'generation').every((e) => !!e.error)).toBe(true);
    expect(env.ledger.candidates()).toEqual([]);
    expect(env.ledger.exhibits()).toEqual([]);
    expect(env.ledger.figures()).toEqual([]);
    expect(researcher.requests).toEqual([]);
    expect(env.twins.state().drive.files.filter((f) => f.appProperties?.role === 'original')).toEqual([]);
    noProhibitedSideEffects(env);

    env.deps.model = new HeuristicModel();
    env.deps.researcher = new FixtureResearcher(WEB_FIXTURES);
    await env.run();
    expect(candidateBySource(env, 'gmail:m-press')?.status).toBe('qualifying');
    expect(exhibitBySource(env, 'gmail:m-press')).toBeDefined();
    expect(env.ledger.figures({ status: 'pending' }).length).toBeGreaterThan(0);
    noProhibitedSideEffects(env);
  });
});

// =====================================================================================
describe('PRD 10 row: Claude web search or web fetch down', () => {
  it('search returns a server-tool error inside HTTP 200: still classifies, maps and files; queues no figure', async () => {
    const env = mk({ seed: figureSeed(), profile: PROFILE_NONE });
    const researcher = failingResearcher('tool-error-200');
    env.deps.researcher = researcher;

    const r = await env.run();
    expect(r.outcome).toBe('ok');
    expect(candidateBySource(env, 'gmail:m-press')?.status).toBe('qualifying');
    expect(exhibitBySource(env, 'gmail:m-press')).toBeDefined();
    expect(researcher.requests.length).toBeGreaterThan(0);
    expect(r.corroboration?.errors).toContain('web_search_tool_result: unavailable');
    expect(env.ledger.figures({ status: 'pending' })).toEqual([]);
    expect(contextNotes(env)).toEqual([]);
    expect(agentOps(env, 'sheets', 'values.append')).toEqual([]);
    expect(scorecardText(env)).toMatch(/O-1A: \d+ of 8/);
    noProhibitedSideEffects(env);
  });

  it('queues the research: once search recovers, the same exhibits are researched and figures proposed', async () => {
    const env = mk({ seed: figureSeed(), profile: PROFILE_NONE });
    env.deps.researcher = failingResearcher('tool-error-200');
    await env.run();

    const spy = spyResearcher(new FixtureResearcher(WEB_FIXTURES));
    env.deps.researcher = spy;
    await env.run();
    expect(spy.requests.map((q) => q.issuerDomain)).toContain('devtoolsweekly.example');
    expect(env.ledger.figures({ status: 'pending' }).length).toBeGreaterThan(0);
    noProhibitedSideEffects(env);
  });

  it('search request throws: the run still completes with exhibits filed, the scorecard written and no figure', async () => {
    const env = mk({ seed: figureSeed(), profile: PROFILE_NONE });
    env.deps.researcher = failingResearcher('throw');

    const { summary, error } = await tryRun(env);
    expect(exhibitBySource(env, 'gmail:m-press')).toBeDefined();
    expect(env.ledger.figures({ status: 'pending' })).toEqual([]);
    noProhibitedSideEffects(env);
    expect(error).toBeNull();
    expect(summary?.outcome).toBe('ok');
    expect(scorecardText(env)).toMatch(/O-1A: \d+ of 8/);
  });

  it('web fetch down: never queues a figure without a fetched snapshot; filing continues', async () => {
    const env = mk({ seed: figureSeed(), profile: PROFILE_NONE });
    const fetcher = failingFetcher('throw');
    env.deps.fetcher = fetcher;

    const { error } = await tryRun(env);
    expect(error).toBeNull();
    expect(fetcher.requested.length).toBeGreaterThan(0);
    expect(exhibitBySource(env, 'gmail:m-press')).toBeDefined();
    expect(env.ledger.figures({ status: 'pending' })).toEqual([]);
    expect(env.twins.state().drive.files.filter((f) => f.mimeType === 'text/html')).toEqual([]);
    expect(contextNotes(env)).toEqual([]);
    noProhibitedSideEffects(env);
  });

  it('queues the research while web fetch is down: after it recovers, figures are proposed', async () => {
    const env = mk({ seed: figureSeed(), profile: PROFILE_NONE });
    env.deps.fetcher = failingFetcher('throw');
    await tryRun(env);

    env.deps.fetcher = new FixtureFetcher(WEB_FIXTURES);
    await env.run();
    expect(env.ledger.figures({ status: 'pending' }).length).toBeGreaterThan(0);
    noProhibitedSideEffects(env);
  });

  it('cached figures are still used while search is down, and nothing is substituted for the rest', async () => {
    const env = mk({ seed: figureSeed(), profile: PROFILE_NONE });
    env.ledger.cacheSet('devtoolsweekly.example|3', WEB_FIXTURES.research['devtoolsweekly.example'], NOW.toISOString());
    const researcher = failingResearcher('tool-error-200');
    env.deps.researcher = researcher;

    const r = await env.run();
    expect(r.corroboration?.cacheHits).toBeGreaterThan(0);
    expect(researcher.requests.map((q) => q.issuerDomain)).not.toContain('devtoolsweekly.example');
    const pending = env.ledger.figures({ status: 'pending' });
    expect(pending.length).toBeGreaterThan(0);
    for (const f of pending) expect(env.ledger.exhibit(f.exhibit_id)?.issuer).toBe('devtoolsweekly.example');
    noProhibitedSideEffects(env);
  });
});

// =====================================================================================
describe('PRD 10 row: Google Sheets down', () => {
  it('control: with Sheets up the same corpus queues figures to the review Sheet', async () => {
    const env = mk({ seed: figureSeed(), profile: PROFILE_NONE });
    await env.run();
    expect(env.ledger.figures({ status: 'pending' }).length).toBeGreaterThan(0);
    expect(agentOps(env, 'sheets', 'values.append').length).toBeGreaterThan(0);
    noProhibitedSideEffects(env);
  });

  it('queueing down: everything else still runs (exhibits, letters, scorecard) with sheets reported degraded', async () => {
    const env = mk({ seed: figureSeed(), profile: PROFILE_NONE });
    env.deps.apps = failingApp(env.deps.apps, 'sheets', 'unavailable');

    const { summary, error } = await tryRun(env);
    expect(env.ledger.exhibits().length).toBeGreaterThan(0);
    noProhibitedSideEffects(env);
    expect(error).toBeNull();
    expect(summary?.degraded).toContain('sheets');
    expect(summary?.letters).not.toBeNull();
    expect(scorecardText(env)).toMatch(/O-1A: \d+ of 8/);
  });

  it('queueing down: nothing reaches the binder without an approval, and no digest claims figures are waiting', async () => {
    const env = mk({ seed: figureSeed(), profile: PROFILE_NONE });
    env.deps.apps = failingApp(env.deps.apps, 'sheets', 'unavailable');

    await tryRun(env);
    expect(contextNotes(env)).toEqual([]);
    expect(env.ledger.figures({ status: 'approved' })).toEqual([]);
    expect(agentOps(env, 'sheets')).toEqual([]);
    expect(agentOps(env, 'gmail', 'messages.send').filter((o) => /figures? waiting for review/.test(String(o.detail.subject)))).toEqual([]);
    noProhibitedSideEffects(env);
  });

  it('figures wait, then reach the review Sheet once Sheets recovers', async () => {
    const env = mk({ seed: figureSeed(), profile: PROFILE_NONE });
    const healthy = env.deps.apps;
    env.deps.apps = failingApp(healthy, 'sheets', 'unavailable');
    await tryRun(env);

    env.deps.apps = healthy;
    await env.run();
    const pending = env.ledger.figures({ status: 'pending' });
    expect(pending.length).toBeGreaterThan(0);
    const sheetId = env.ledger.get('review_sheet');
    const rows = env.twins.state().sheets.find((s) => s.spreadsheetId === sheetId)?.rows ?? [];
    const ids = rows.slice(1).map((row) => row[0]);
    for (const f of pending) expect(ids).toContain(f.fig_id);
    noProhibitedSideEffects(env);
  });

  it('reading decisions down: an Approve in the Sheet is not applied and nothing is written', async () => {
    const env = mk({ seed: figureSeed(), profile: PROFILE_NONE });
    await env.run();
    const fig = env.ledger.figures({ status: 'pending' })[0]!;
    approveInSheet(env, fig.fig_id);
    env.deps.apps = failingApp(env.deps.apps, 'sheets', 'unavailable');

    await tryRun(env);
    expect(env.ledger.figure(fig.fig_id)?.status).toBe('pending');
    expect(contextNotes(env)).toEqual([]);
    noProhibitedSideEffects(env);
  });

  it('reading decisions down: the run still completes with sheets reported degraded', async () => {
    const env = mk({ seed: figureSeed(), profile: PROFILE_NONE });
    await env.run();
    approveInSheet(env, env.ledger.figures({ status: 'pending' })[0]!.fig_id);
    env.deps.apps = failingApp(env.deps.apps, 'sheets', 'unavailable');

    const { summary, error } = await tryRun(env);
    noProhibitedSideEffects(env);
    expect(error).toBeNull();
    expect(summary?.degraded).toContain('sheets');
  });
});

// =====================================================================================
describe('PRD 10 row: Twilio down', () => {
  function twilioEnv(): HarnessEnv {
    const env = mk({
      seed: seed({ gmail: [...E.buildnight.gmail, ...E.press], calendar: E.buildnight.calendar }),
      profile: PROFILE_PRIYA,
      twilio: () => failingTwilio(),
      extensions: () => [createTextChannel({ parser: new HeuristicCommandParser() }), createNotifier()],
    });
    env.clock.set(new Date('2026-09-13T16:00:00Z')); // 09:00 PDT, outside quiet hours
    return env;
  }

  it('still does everything else; texts stop in both directions', async () => {
    const env = twilioEnv();
    const r = await env.run();
    expect(r.outcome).toBe('ok');
    expect(env.ledger.exhibits().length).toBeGreaterThan(0);
    expect(scorecardText(env)).toMatch(/O-1A: \d+ of 8/);
    expect(r.degraded).toContain('text-channel');
    const twilio = env.deps.apps.twilio as ReturnType<typeof failingTwilio>;
    expect(twilio.fault.attempts).toContain('listInbound');
    expect(env.twins.ops.filter((o) => o.app === 'twilio')).toEqual([]);
    expect(env.ledger.events({ kind: 'text_in' })).toEqual([]);
    expect(env.ledger.events({ kind: 'text_out' })).toEqual([]);
    expect(env.ledger.events({ kind: 'notification' }).filter((e) => e.detail.sent === true)).toEqual([]);
    noProhibitedSideEffects(env);
  });

  it('decisions still arrive through the Sheet and email', async () => {
    const env = twilioEnv();
    const id = letterId(PRIYA);
    await env.run();
    expect(env.ledger.letter(id)?.state).toBe('approval_requested');
    const fig = env.ledger.figures({ status: 'pending' })[0]!;
    approveInSheet(env, fig.fig_id);
    founderReply(env, `Re: [Exhibit] Approve letter request ${id} to ${PRIYA.name}`, `APPROVE ${id}`);

    await env.run();
    expect(env.ledger.figure(fig.fig_id)?.status).toBe('approved');
    expect(contextNotes(env).map((f) => Buffer.from(f.content).toString('utf8')).join('\n')).toContain(`- ${fig.fig_id}:`);
    expect(env.ledger.letter(id)?.state).toBe('sent');
    expect(sendsToOthers(env).filter((o) => (o.detail.to as string[]).includes(PRIYA.email))).toHaveLength(1);
    expect(env.twins.ops.filter((o) => o.app === 'twilio')).toEqual([]);
    noProhibitedSideEffects(env);
  });
});

// =====================================================================================
describe('PRD 10 row: any discovery source down', () => {
  const PH_URL = 'https://www.producthunt.example/posts/loomwork-2026';
  const HN_URL = 'https://news.ycombinator.example/item?id=41000001';

  function source(id: string, item: (q: DiscoveryQuery) => DiscoveredItem): DiscoveryAdapter & { down: boolean } {
    const adapter = {
      down: false,
      info: { id, name: `${id} (test double)`, job: ['discover' as const], tier: 2 as const, criteria: '#1, #5', freeTier: 'n/a', credentials: [], receives: 'nothing; synthetic fixture only' },
      async discover(q: DiscoveryQuery) {
        if (adapter.down) throw new Error(`${id} unreachable (injected fault)`);
        return { items: [item(q)], errors: [] };
      },
    };
    return adapter;
  }
  const badge = (q: DiscoveryQuery): DiscoveredItem => ({ source: 'producthunt', externalId: 'loomwork-2026', kind: 'badge', url: PH_URL, title: `${q.company} is Product of the Day`, text: `${q.founderName}'s ${q.company} won Product of the Day.`, publishedAt: '2026-04-11T00:00:00.000Z', author: { name: q.founderName }, meta: { badge: 'Product of the Day' }, raw: '{}' });
  const hnPost = (q: DiscoveryQuery): DiscoveredItem => ({ source: 'hackernews', externalId: '41000001', kind: 'launch', url: HN_URL, title: `Show HN: ${q.company} - a CI flakiness detector`, text: `Show HN: ${q.company} - a CI flakiness detector\nSubmitted by ${q.founderName} of ${q.company}.`, publishedAt: '2026-04-10T15:00:00.000Z', author: { name: q.founderName, handle: q.handles[0] }, submittedByFounder: true, meta: {}, raw: '{}' });

  it('still does everything else; the down source yields no candidates and is not marked as run', async () => {
    const broken = source('ph-fake', badge);
    broken.down = true;
    const healthy = source('hn-fake', hnPost);
    const env = mk({ seed: seed({ gmail: E.press }), profile: PROFILE_NONE, extensions: () => [createDiscoveryExtension({ adapters: [broken, healthy], alwaysRun: true })] });

    const r = await env.run();
    expect(r.outcome).toBe('ok');
    expect(r.degraded).toContain('ph-fake');
    expect(env.ledger.candidates().some((c) => c.url === HN_URL)).toBe(true);
    expect(env.ledger.candidates().some((c) => c.url === PH_URL)).toBe(false);
    expect(env.ledger.get('discovery_last_run:ph-fake')).toBeFalsy();
    expect(env.ledger.get('discovery_last_run:hn-fake')).toBeTruthy();
    expect(exhibitBySource(env, 'gmail:m-press')).toBeDefined();
    noProhibitedSideEffects(env);
  });

  it('new candidates from that source resume once it recovers', async () => {
    const broken = source('ph-fake', badge);
    broken.down = true;
    const env = mk({ seed: seed({ gmail: E.press }), profile: PROFILE_NONE, extensions: () => [createDiscoveryExtension({ adapters: [broken], alwaysRun: true })] });
    await env.run();
    broken.down = false;
    await env.run();
    expect(env.ledger.candidates().some((c) => c.url === PH_URL)).toBe(true);
    noProhibitedSideEffects(env);
  });

  it('a transport outage at one API (GDELT) removes only that source; Hugging Face and Gmail continue', async () => {
    const transport = failingTransport(new FixtureTransport(DISCOVERY_TIER1_FIXTURES), /gdeltproject\.org$/);
    const env = mk({ seed: seed({ gmail: E.press }), profile: PROFILE_NONE, extensions: () => [createDiscoveryExtension({ adapters: [createGdeltAdapter({ transport }), createHuggingFaceAdapter({ transport })], alwaysRun: true })] });

    const r = await env.run();
    expect(r.outcome).toBe('ok');
    expect(transport.refused.length).toBeGreaterThan(0);
    expect(env.ledger.candidates().some((c) => c.url === GDELT_ARTICLES.newFromGdelt.url)).toBe(false);
    expect(env.ledger.candidates().some((c) => c.sources.some((s) => s.id.startsWith('gdelt:')))).toBe(false);
    expect(env.ledger.candidates().some((c) => c.url?.includes('huggingface.co/loomwork/flaky-ci-classifier'))).toBe(true);
    expect(env.ledger.exhibits().filter((e) => hasSource(e.sources, 'gmail:m-press'))).toHaveLength(1);
    noProhibitedSideEffects(env);
  });
});

// =====================================================================================
describe('PRD 10 row: a verifier API down', () => {
  const verifierSeed = () => seed({ gmail: [...E.safe, ...E.press] });
  const payCriterion = (q: ResearchRequest) => q.criterion === 8;

  function verifierEnv() {
    const env = mk({ seed: verifierSeed(), profile: PROFILE_NONE });
    const spy = spyResearcher(new FixtureResearcher(WEB_FIXTURES));
    env.deps.researcher = spy;
    return { env, spy };
  }

  function assertFigureWaits(env: HarnessEnv, spy: ReturnType<typeof spyResearcher>) {
    const pay = exhibitBySource(env, 'gmail:m-safe');
    expect(pay?.criteria).toContain(8);
    // No web search for the figure the API should have supplied; other figures still researched.
    expect(spy.requests.filter(payCriterion)).toEqual([]);
    expect(spy.requests.map((q) => q.issuerDomain)).toContain('devtoolsweekly.example');
    // The figure waits: no row of any status for that exhibit, and it is not marked corroborated.
    expect(env.ledger.figures().filter((f) => f.exhibit_id === pay!.exhibit_id)).toEqual([]);
    expect(env.ledger.get(`corroborated:${pay!.exhibit_id.split('.v')[0]}`)).toBeFalsy();
  }

  it('limited (free-tier limit): the figure waits and web search is not substituted', async () => {
    const { env, spy } = verifierEnv();
    const structured = failingStructured('limited', { when: payCriterion });
    env.deps.structured = structured;

    const r = await env.run();
    expect(r.outcome).toBe('ok');
    expect(structured.faulted.length).toBeGreaterThan(0);
    expect(r.corroboration?.limited).toBeGreaterThan(0);
    assertFigureWaits(env, spy);
    noProhibitedSideEffects(env);
  });

  it('hard failure (the API client throws): the run completes, the figure waits, web search is not substituted', async () => {
    const { env, spy } = verifierEnv();
    env.deps.structured = failingStructured('throw', { when: payCriterion });

    const { summary, error } = await tryRun(env);
    expect(spy.requests.filter(payCriterion)).toEqual([]);
    noProhibitedSideEffects(env);
    expect(error).toBeNull();
    expect(summary?.outcome).toBe('ok');
    assertFigureWaits(env, spy);
  });

  it('API outage returned as HTTP 503 from BLS and O*NET: web search is not substituted for the pay benchmark', async () => {
    const { env, spy } = verifierEnv();
    const transport = failingTransport(new FixtureTransport(VERIFIER_API_FIXTURES), /(^|\.)bls\.gov$|(^|\.)onetcenter\.org$/, { status: 503 });
    env.deps.structured = createStructuredResearch({ adapters: [createBlsAdapter({ transport, registrationKey: 'test-key' }), createOnetAdapter({ transport, username: 'evidence', key: 'test-key' })] });

    const r = await env.run();
    expect(r.outcome).toBe('ok');
    expect(transport.refused.length).toBeGreaterThan(0);
    noProhibitedSideEffects(env);
    assertFigureWaits(env, spy);
  });
});

// =====================================================================================
describe('PRD 10 row: Internet Archive or OpenTimestamps down', () => {
  function integrityEnv(host: RegExp, status?: number) {
    const fixtures = createIntegrityFixtures();
    const transport = failingTransport(new FixtureTransport(fixtures.fixtures), host, { status });
    const env = mk({
      seed: figureSeed(),
      profile: PROFILE_NONE,
      extensions: () => [createIntegrityExtension({ transport, archiveKeys: { accessKey: 'test-access', secretKey: 'test-secret' }, blockHeaders: fixtures.blockHeaders })],
    });
    return { env, transport };
  }
  const OTS_HOSTS = /(^|\.)opentimestamps\.org$|(^|\.)eternitywall\.com$/;
  const ARCHIVE_HOSTS = /(^|\.)archive\.org$/;

  function originals(env: HarnessEnv) {
    return env.twins.state().drive.files.filter((f) => f.appProperties?.role === 'original');
  }

  it('OpenTimestamps down: still files with local hashes; no proof is created or claimed', async () => {
    const { env, transport } = integrityEnv(OTS_HOSTS);
    const r = await env.run();
    expect(r.outcome).toBe('ok');
    expect(transport.refused.length).toBeGreaterThan(0);
    const exhibits = env.ledger.exhibits();
    expect(exhibits.length).toBeGreaterThan(0);
    for (const e of exhibits) {
      const file = originals(env).find((f) => f.appProperties?.exhibit_id === e.exhibit_id);
      expect(file?.sha256).toBe(e.sha256);
    }
    expect(env.twins.state().drive.files.filter((f) => f.appProperties?.role === 'ots')).toEqual([]);
    expect(env.ledger.events({ kind: 'timestamp' })).toEqual([]);
    for (const f of originals(env)) expect(env.ledger.get(`ots:${f.id}`)).toBeFalsy();
    expect(scorecardText(env)).toMatch(/O-1A: \d+ of 8/);
    noProhibitedSideEffects(env);
  });

  it('OpenTimestamps proofs are queued and retried once the calendars recover', async () => {
    const { env, transport } = integrityEnv(OTS_HOSTS);
    await env.run();
    transport.down = false;
    await env.run();
    const files = originals(env);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(JSON.parse(env.ledger.get(`ots:${f.id}`) ?? '{}').status).toBe('pending');
    noProhibitedSideEffects(env);
  });

  async function approveWithArchiveDown() {
    const ctx = integrityEnv(ARCHIVE_HOSTS, 503);
    await ctx.env.run();
    const fig = ctx.env.ledger.figures({ status: 'pending' })[0]!;
    approveInSheet(ctx.env, fig.fig_id);
    await ctx.env.run();
    const urls = ctx.env.ledger.figure(fig.fig_id)!.sources.map((s) => s.url).filter((u) => /^https?:\/\//.test(u));
    return { ...ctx, fig, urls };
  }

  it('Internet Archive down: approvals still land in the binder; the failed archive attempt is recorded, never faked', async () => {
    const { env, transport, fig, urls } = await approveWithArchiveDown();
    expect(transport.refused.length).toBeGreaterThan(0);
    expect(env.ledger.figure(fig.fig_id)?.status).toBe('approved');
    expect(contextNotes(env).map((f) => Buffer.from(f.content).toString('utf8')).join('\n')).toContain(`- ${fig.fig_id}:`);
    const attempts = env.ledger.events({ kind: 'archive' }).filter((e) => e.detail.fig_id === fig.fig_id);
    expect(attempts.length).toBeGreaterThan(0);
    for (const a of attempts) {
      expect(a.detail.ok).toBe(false);
      expect(a.detail.archive_url).toBeFalsy();
      expect(a.detail.reason).toBeTruthy();
    }
    for (const u of urls) expect(env.ledger.get(`archived:${u}`)).toBeFalsy();
    noProhibitedSideEffects(env);
  });

  it('Internet Archive links are queued and retried once it recovers', async () => {
    const { env, transport, urls } = await approveWithArchiveDown();
    expect(urls.length).toBeGreaterThan(0);
    transport.down = false;
    await env.run();
    for (const u of urls) expect(env.ledger.get(`archived:${u}`)).toBeTruthy();
    noProhibitedSideEffects(env);
  });
});

// =====================================================================================
describe('PRD 10 row: Dropbox Sign down', () => {
  const PROFILE_SIGN: FounderProfile = { ...PROFILE_PRIYA, controlledEmails: [...(DARA.controlledEmails ?? []), PRIYA.email] };
  const id = letterId(PRIYA);

  async function signingEnvAtSignatureApproval() {
    let inner: MemoryDropboxSign | null = null;
    let client: ReturnType<typeof failingDropboxSign> | null = null;
    const env = mk({
      seed: seed({ gmail: E.buildnight.gmail, calendar: E.buildnight.calendar }),
      profile: PROFILE_SIGN,
      extensions: (e) => {
        inner = new MemoryDropboxSign({ testMode: true, now: e.clock.now, record: e.twins.recordOp.bind(e.twins) });
        client = failingDropboxSign(inner);
        return [createSigningExtension({ client, dayMode: true })];
      },
    });
    await env.run(); // letter drafted, approval requested
    founderReply(env, `Re: [Exhibit] Approve letter request ${id} to ${PRIYA.name}`, `APPROVE ${id}`);
    await env.run(); // letter request sent to Priya
    const thread = env.ledger.letter(id)?.sent_msg_id;
    if (!thread) throw new Error(`letter ${id} was not sent; state ${env.ledger.letter(id)?.state}`);
    founderReply(env, 'Re: Would you consider a recommendation letter for Dara Voss?', 'I confirm the final text is good to sign.', 10_000, { threadId: thread, from: `${PRIYA.name} <${PRIYA.email}>` });
    await env.run(); // signature approval requested from the founder
    founderReply(env, `Re: [Exhibit] Approve signature request ${id}`, `APPROVE SIGN ${id}`, 30_000);
    return { env, inner: inner! as MemoryDropboxSign, client: client! as ReturnType<typeof failingDropboxSign> };
  }

  it('still does letter drafts and approvals; the signature request is queued, not dropped', async () => {
    const { env, inner, client } = await signingEnvAtSignatureApproval();
    const r = await env.run(); // Dropbox Sign is down for this run
    expect(r.outcome).toBe('ok');
    expect(env.twins.state().docs.some((d) => d.title.startsWith('Letter draft') && d.text.length > 0)).toBe(true);
    expect(env.ledger.letter(id)?.state).toBe('sent');
    expect(agentOps(env, 'gmail', 'messages.send').some((o) => String(o.detail.subject).startsWith(`[Exhibit] Approve signature request ${id}`))).toBe(true);
    expect(client.fault.attempts).toContain('send');
    expect(r.degraded).toContain('signing');
    expect(inner.state().requests).toEqual([]);
    expect(JSON.parse(env.ledger.get(`sign:${id}`) ?? '{}').stage).toBe('awaiting_approval');
    expect(env.ledger.events({ kind: 'signature' }).filter((e) => e.detail.status === 'created')).toEqual([]);
    noProhibitedSideEffects(env);
  });

  it('the queued signature request goes out once Dropbox Sign recovers', async () => {
    const { env, inner, client } = await signingEnvAtSignatureApproval();
    await env.run();
    client.fault.down = false;
    await env.run();
    const requests = inner.state().requests;
    expect(requests).toHaveLength(1);
    expect(requests[0]!.signerEmail).toBe(PRIYA.email);
    expect(requests[0]!.testMode).toBe(true);
    expect(JSON.parse(env.ledger.get(`sign:${id}`) ?? '{}').stage).toBe('requested');
    noProhibitedSideEffects(env);
  });
});

// =====================================================================================
describe('PRD 10 row: Gmail down', () => {
  it('still does Calendar, GitHub and LinkedIn intake', async () => {
    const env = mk({ seed: fullYearSeed() });
    env.deps.apps = failingApp(env.deps.apps, 'gmail', 'unavailable');

    const { summary, error } = await tryRun(env);
    noProhibitedSideEffects(env);
    expect(error).toBeNull();
    expect(summary?.degraded).toContain('gmail');
    expect(candidateBySource(env, 'calendar:ev-hm')).toBeDefined();
    expect(candidateBySource(env, 'github:loomwork/flakehound@2026-09-13')).toBeDefined();
    expect(candidateBySource(env, 'linkedin:li-sn')).toBeDefined();
  });

  it('stops most evidence and all sends', async () => {
    const env = mk({ seed: fullYearSeed() });
    env.deps.apps = failingApp(env.deps.apps, 'gmail', 'unavailable');

    await tryRun(env);
    expect(agentOps(env, 'gmail', 'messages.send')).toEqual([]);
    expect(env.ledger.candidates().filter((c) => c.sources.some((s) => s.app === 'gmail'))).toEqual([]);
    expect(env.ledger.letters().filter((l) => l.state === 'sent' || l.state === 'approval_requested')).toEqual([]);
    noProhibitedSideEffects(env);
  });
});

// =====================================================================================
describe('PRD 10 row: Google Calendar down', () => {
  // Build Night: invite and acceptance by email, the event itself only on the Calendar (no certificate).
  // HackMesa: a thank-you email proves service without the Calendar.
  const calendarSeed = () =>
    seed({
      gmail: [...E.buildnight.gmail.filter((m) => m.id !== 'm-bn-cert'), ...E.hackmesa.gmail, ...E.press],
      calendar: [...E.buildnight.calendar, ...E.hackmesa.calendar],
    });

  it('control: with Calendar up, the event promotes Build Night judging to qualifying', async () => {
    const env = mk({ seed: calendarSeed(), profile: PROFILE_NONE });
    await env.run();
    expect(candidateBySource(env, 'gmail:m-bn-invite')?.status).toBe('qualifying');
    noProhibitedSideEffects(env);
  });

  it('still does everything else; stops promoting #4 from building to qualifying', async () => {
    const env = mk({ seed: calendarSeed(), profile: PROFILE_NONE });
    env.deps.apps = failingApp(env.deps.apps, 'calendar', 'unavailable');

    const { summary, error } = await tryRun(env);
    noProhibitedSideEffects(env);
    expect(error).toBeNull();
    expect(summary?.degraded).toContain('calendar');
    expect(candidateBySource(env, 'gmail:m-bn-invite')?.status).toBe('building');
    expect(candidateBySource(env, 'gmail:m-hm-invite')?.status).toBe('qualifying');
    expect(candidateBySource(env, 'gmail:m-press')?.status).toBe('qualifying');
    expect(scorecardText(env)).toMatch(/O-1A: \d+ of 8/);
  });

  it('never files #4 as qualifying on evidence only the Calendar holds', async () => {
    const env = mk({ seed: calendarSeed(), profile: PROFILE_NONE });
    env.deps.apps = failingApp(env.deps.apps, 'calendar', 'unavailable');

    await tryRun(env);
    expect(candidateBySource(env, 'gmail:m-bn-invite')?.status).not.toBe('qualifying');
    expect(env.ledger.exhibits().filter((e) => hasSource(e.sources, 'gmail:m-bn-invite') && e.status === 'qualifying')).toEqual([]);
    expect(agentOps(env, 'calendar')).toEqual([]);
    noProhibitedSideEffects(env);
  });
});

// =====================================================================================
describe('PRD 10 row: Google Drive down', () => {
  const driveSeed = () => seed({ gmail: [...E.press, ...E.accelerator] });

  it('still maps and records candidates in the ledger; filing stops and items stay queued', async () => {
    const env = mk({ seed: driveSeed(), profile: PROFILE_NONE });
    env.deps.apps = failingApp(env.deps.apps, 'drive', 'unavailable');

    const { summary, error } = await tryRun(env);
    noProhibitedSideEffects(env);
    expect(error).toBeNull();
    expect(summary?.degraded).toContain('drive');
    const press = candidateBySource(env, 'gmail:m-press');
    expect(press?.status).toBe('qualifying');
    expect(press?.exhibit_id).toBeNull();
    expect(env.ledger.exhibits()).toEqual([]);
    expect(env.ledger.itemSeen('gmail', 'm-press')?.stage).not.toBe('done');
  });

  it('nothing is marked filed while Drive is down', async () => {
    const env = mk({ seed: driveSeed(), profile: PROFILE_NONE });
    env.deps.apps = failingApp(env.deps.apps, 'drive', 'unavailable');

    await tryRun(env);
    expect(env.ledger.exhibits()).toEqual([]);
    expect(env.ledger.candidates().filter((c) => c.exhibit_id !== null)).toEqual([]);
    expect(agentOps(env, 'drive')).toEqual([]);
    noProhibitedSideEffects(env);
  });

  it('queued items are filed once Drive recovers', async () => {
    const env = mk({ seed: driveSeed(), profile: PROFILE_NONE });
    const healthy = env.deps.apps;
    env.deps.apps = failingApp(healthy, 'drive', 'unavailable');
    await tryRun(env);

    env.deps.apps = healthy;
    await env.run();
    expect(exhibitBySource(env, 'gmail:m-press')?.status).toBe('qualifying');
    noProhibitedSideEffects(env);
  });
});

// =====================================================================================
describe('PRD 10 row: Google Docs down', () => {
  const docsSeed = () => seed({ gmail: [...E.buildnight.gmail, ...E.press], calendar: E.buildnight.calendar });

  it('still files; the run completes with docs reported degraded and the ledger closes the run', async () => {
    const env = mk({ seed: docsSeed(), profile: PROFILE_PRIYA });
    env.deps.apps = failingApp(env.deps.apps, 'docs', 'unavailable');

    const { summary, error } = await tryRun(env);
    expect(env.ledger.exhibits().length).toBeGreaterThan(0);
    noProhibitedSideEffects(env);
    expect(error).toBeNull();
    expect(summary?.degraded).toContain('docs');
    const row = env.ledger.runs().at(-1);
    expect(row?.finished_at).toBeTruthy();
    expect(row?.outcome).toBeTruthy();
  });

  it('stops the scorecard and letter drafts; the ledger and Drive stay authoritative', async () => {
    const env = mk({ seed: docsSeed(), profile: PROFILE_PRIYA });
    env.deps.apps = failingApp(env.deps.apps, 'docs', 'unavailable');

    await tryRun(env);
    expect(agentOps(env, 'docs')).toEqual([]);
    const files = env.twins.state().drive.files;
    const exhibits = env.ledger.exhibits();
    expect(exhibits.length).toBeGreaterThan(0);
    for (const e of exhibits) expect(files.find((f) => f.appProperties?.role === 'original' && f.appProperties?.exhibit_id === e.exhibit_id)?.sha256).toBe(e.sha256);
    expect(env.ledger.letters().filter((l) => l.doc_id !== null || l.state === 'approval_requested' || l.state === 'sent')).toEqual([]);
    expect(sendsToOthers(env)).toEqual([]);
    noProhibitedSideEffects(env);
  });
});

// =====================================================================================
describe('PRD 10 row: GitHub or LinkedIn down', () => {
  it('GitHub unavailable: everything else runs; no criterion 5 signal from GitHub', async () => {
    const env = mk({ seed: fullYearSeed() });
    env.deps.apps = failingApp(env.deps.apps, 'github', 'unavailable');

    const r = await env.run();
    expect(r.outcome).toBe('ok');
    expect(scorecardText(env)).toMatch(/Degraded this run:.*github/);
    expect(env.ledger.candidates().filter((c) => c.sources.some((s) => s.app === 'github'))).toEqual([]);
    expect(candidateBySource(env, 'gmail:m-press')?.status).toBe('qualifying');
    expect(candidateBySource(env, 'linkedin:li-sn')).toBeDefined();
    noProhibitedSideEffects(env);
  });

  it('LinkedIn unavailable: everything else runs; no criterion 3 signal from LinkedIn', async () => {
    const env = mk({ seed: fullYearSeed() });
    env.deps.apps = failingApp(env.deps.apps, 'linkedin', 'unavailable');

    const r = await env.run();
    expect(r.outcome).toBe('ok');
    expect(scorecardText(env)).toMatch(/Degraded this run:.*linkedin/);
    expect(env.ledger.candidates().filter((c) => c.sources.some((s) => s.app === 'linkedin'))).toEqual([]);
    expect(candidateBySource(env, 'gmail:m-press')?.status).toBe('qualifying');
    expect(candidateBySource(env, 'github:loomwork/flakehound@2026-09-13')).toBeDefined();
    noProhibitedSideEffects(env);
  });

  it('GitHub failing with a raw network error (what the live Octokit client throws) is still only github degraded', async () => {
    const env = mk({ seed: fullYearSeed() });
    env.deps.apps = failingApp(env.deps.apps, 'github', 'throw');

    const { summary, error } = await tryRun(env);
    noProhibitedSideEffects(env);
    expect(error).toBeNull();
    expect(summary?.degraded).toContain('github');
    expect(candidateBySource(env, 'gmail:m-press')?.status).toBe('qualifying');
  });
});

// =====================================================================================
describe('PRD 10 row: worth-sending down', () => {
  it('still does everything else; every letter is held and reported, nothing is sent', async () => {
    const env = mk({ seed: fullYearSeed() });
    const gate = unavailableGate();
    env.deps.gate = gate;

    const r = await env.run();
    expect(r.outcome).toBe('ok');
    expect(env.ledger.exhibits().length).toBeGreaterThan(0);
    expect(gate.attempts).toBeGreaterThan(0);
    expect(r.letters?.held.length).toBeGreaterThan(0);
    for (const h of r.letters!.held) expect(h.reasons).toEqual(['worth-sending unavailable']);
    expect(r.letters?.sent).toEqual([]);
    expect(r.letters?.approvalRequested).toEqual([]);
    expect(env.ledger.letters().every((l) => l.state === 'held')).toBe(true);
    expect(scorecardText(env)).toContain('worth-sending unavailable');
    expect(sendsToOthers(env)).toEqual([]);
    expect(agentOps(env, 'gmail', 'messages.send').filter((o) => String(o.detail.subject).startsWith('[Exhibit] Approve letter'))).toEqual([]);
    noProhibitedSideEffects(env);
  });

  it('a founder APPROVE cannot push a held letter out while the gate is down', async () => {
    const env = mk({ seed: fullYearSeed() });
    env.deps.gate = unavailableGate();
    await env.run();
    let offset = 60_000;
    for (const l of env.ledger.letters()) {
      founderReply(env, `Re: [Exhibit] Approve letter request ${l.letter_id}`, `APPROVE ${l.letter_id}`, offset);
      offset += 60_000;
    }
    await env.run();
    expect(sendsToOthers(env)).toEqual([]);
    expect(env.ledger.letters().every((l) => l.state === 'held')).toBe(true);
    noProhibitedSideEffects(env);
  });
});


// =====================================================================================
describe('PRD 10 row: uberprompt down', () => {
  it('the built-in dependents check and everything else run with no uberprompt binary on PATH', async () => {
    const oldPath = process.env.PATH;
    process.env.PATH = '/nonexistent/uberprompt-is-down';
    try {
      const g = graph();
      expect(validateGraph(g)).toEqual([]);
      const a = affected(g, ['decisions-5-5']);
      expect(a.prompts.length).toBeGreaterThan(0);
      expect(a.prompts).toEqual(expect.arrayContaining(['mapper']));
      for (const p of a.prompts) expect(g.prompts.get(p)?.uses).toContain('decisions-5-5');
      expect(a.scenarios.length).toBeGreaterThan(0);

      const env = mk({ seed: figureSeed(), profile: PROFILE_NONE });
      const r = await env.run();
      expect(r.outcome).toBe('ok');
      expect(env.ledger.exhibits().length).toBeGreaterThan(0);
      noProhibitedSideEffects(env);
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it('no Exhibit source file shells out to uberprompt (the fallback is the only dependents check)', () => {
    const root = join(import.meta.dirname, '..', 'src');
    const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts'));
    const offenders = files.filter((f) => /\b(exec|execFile|spawn|fork)(Sync)?\(\s*['"`]uberprompt/.test(readFileSync(join(root, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});

// =====================================================================================
describe('PRD 10 row: Arga down', () => {
  it('the in-memory harness runs with Arga unavailable, and the live agent path never imports Arga', async () => {
    const oldKey = process.env.ARGA_API_KEY;
    delete process.env.ARGA_API_KEY;
    try {
      const env = mk({ seed: figureSeed(), profile: PROFILE_NONE });
      const r = await env.run();
      expect(env.twins.backend).toBe('memory');
      expect(r.outcome).toBe('ok');
      expect(env.ledger.exhibits().length).toBeGreaterThan(0);
      noProhibitedSideEffects(env);
    } finally {
      if (oldKey !== undefined) process.env.ARGA_API_KEY = oldKey;
    }
    const repo = join(import.meta.dirname, '..');
    const liveDir = join(repo, 'src', 'apps', 'live');
    const livePath = ['src/agent.ts', 'harness/env.ts', ...readdirSync(liveDir).filter((f) => f.endsWith('.ts')).map((f) => `src/apps/live/${f}`)];
    // Runtime imports only: `import type` is erased and loads nothing.
    const runtimeArgaImport = /^\s*import\s+(?!type\b)[^;]*from\s+['"](arga-sdk|[^'"]*\/arga(-backend)?(\.js)?)['"]/m;
    for (const f of livePath) expect(readFileSync(join(repo, f), 'utf8'), f).not.toMatch(runtimeArgaImport);
  });

  it('stops evaluation runs: provisioning twins fails loudly instead of pretending', async () => {
    const { provisionArgaTwins } = await import('../harness/arga.js');
    await expect(provisionArgaTwins({ apiKey: 'arga_sk_test', pollMs: 1, timeoutMs: 1 })).rejects.toThrow(/Arga unavailable/);
  });
});
