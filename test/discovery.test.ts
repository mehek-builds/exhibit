import { afterEach, describe, expect, it } from 'vitest';
import { classifyDiscovered } from '../src/discovery/classify.js';
import { createDiscoveryExtension } from '../src/discovery/extension.js';
import { secondIdentifier } from '../src/discovery/identity.js';
import { createGdeltAdapter } from '../src/integrations/gdelt.js';
import { createHuggingFaceAdapter } from '../src/integrations/huggingface.js';
import type { DiscoveredItem, DiscoveryAdapter, DiscoveryQuery } from '../src/integrations/types.js';
import { FixtureTransport, toSourceItem } from '../src/integrations/types.js';
import { registerDiscoveryClassifier } from '../src/rules/structured.js';
import type { ExtensionContext } from '../src/agent.js';
import { DISCOVERY_TIER1_FIXTURES, GDELT_ARTICLES, HUGGINGFACE_MODEL } from '../harness/fixtures/discovery-tier1.js';
import { S21 } from '../harness/scenarios/s21.js';
import { runScenarioAttempt } from '../harness/runner.js';
import { PROFILE } from './helpers.js';

// PRD 6.14, 8 (constraint 16), 9 (E57-E62): the second-identifier rule, structured classification of
// discovered kinds, the discovery extension's dedupe/degrade/retry behavior, and S21 end to end.

// registerDiscoveryClassifier mutates module-level global state in src/rules/structured.ts. One
// test below registers a classifier directly (bypassing the extension, which would otherwise
// register/restore it itself); reset it after every test so this file never leaves global state
// behind for whatever runs next in this worker (matters if isolate:false is ever enabled).
afterEach(() => {
  registerDiscoveryClassifier(null);
});

const Q: DiscoveryQuery = {
  founderName: 'Dara Voss',
  aliases: ['Dara', 'D. Voss'],
  company: 'Loomwork',
  companyDomain: 'loomwork.example',
  handles: ['dvoss', 'loomwork'],
  coauthors: ['Ren Park'],
  since: '2026-01-01T00:00:00.000Z',
};

function discoveredItem(p: Partial<DiscoveredItem> & { title: string; text: string }): DiscoveredItem {
  return {
    source: 'test',
    externalId: 'x1',
    kind: 'article',
    url: 'https://example.example/a',
    publishedAt: null,
    meta: {},
    raw: '{}',
    ...p,
  };
}

describe('secondIdentifier (E57, E61)', () => {
  it('accepts a source that names the founder and her company', () => {
    const it_ = discoveredItem({ title: 'Dara Voss of Loomwork raises the bar', text: 'Dara Voss of Loomwork raises the bar for AI infrastructure.' });
    const r = secondIdentifier(it_, Q);
    expect(r.names).toBe(true);
    expect(r.second).toBe('company:Loomwork');
  });

  it('accepts a source that names the founder and a known handle', () => {
    const it_ = discoveredItem({ title: 'Show HN', text: 'Submitted by dvoss.', author: { handle: 'dvoss' } });
    const r = secondIdentifier(it_, Q);
    expect(r.second).toBe('handle:dvoss');
  });

  it('accepts a source that names the founder and a co-author', () => {
    const it_ = discoveredItem({ title: 'Paper', text: 'Dara Voss and Ren Park publish a new paper.' });
    const r = secondIdentifier(it_, Q);
    expect(r.second).toBe('coauthor:Ren Park');
  });

  it('rejects a namesake with no second identifier (E57)', () => {
    const it_ = discoveredItem({ title: 'Chef Dara Voss', text: 'Dara Voss, the Lisbon chef reinventing the tasca.' });
    const r = secondIdentifier(it_, Q);
    expect(r.names).toBe(true);
    expect(r.second).toBeNull();
  });

  it('rejects a look-alike company filing that never names the founder (E61)', () => {
    const it_ = discoveredItem({ title: 'Form D: Loomworks Capital LLC', text: 'Form D filed by Loomworks Capital LLC, a private fund manager.' });
    const r = secondIdentifier(it_, Q);
    expect(r.names).toBe(false);
    expect(r.second).toBeNull();
  });

  it('is word-bounded: "Loomworks" never matches the company "Loomwork"', () => {
    const it_ = discoveredItem({ title: 'Dara Voss profile', text: 'Dara Voss now advises Loomworks Capital LLC.' });
    const r = secondIdentifier(it_, Q);
    // "Loomwork" as a whole word is not present; only "Loomworks" is.
    expect(r.second).not.toBe('company:Loomwork');
  });
});

describe('classifyDiscovered structured kinds (E59, E60, E62)', () => {
  const now = new Date('2026-09-13T12:00:00Z');

  it('a self-submitted launch is X-self-submitted-launch, #5 building, never #3 (E59)', () => {
    const si = toSourceItem(discoveredItem({ kind: 'launch', title: 'Show HN', text: 'Show HN: Loomwork', submittedByFounder: true }));
    const out = classifyDiscovered(si, PROFILE, now);
    expect(out).not.toBeNull();
    expect(out!.mapping!.rule_id).toBe('X-self-submitted-launch');
    expect(out!.mapping!.criteria).toEqual([5]);
    expect(out!.mapping!.status).toBe('building');
    expect(out!.mapping!.criteria).not.toContain(3);
  });

  it('a launch not submitted by the founder falls through (returns null, like press)', () => {
    const si = toSourceItem(discoveredItem({ kind: 'launch', title: 'Loomwork launches', text: 'Loomwork launches on Product Hunt.', submittedByFounder: false }));
    expect(classifyDiscovered(si, PROFILE, now)).toBeNull();
  });

  it('a Product Hunt badge is N-badge-no-rule, #1 needs_attorney (E60)', () => {
    const si = toSourceItem(discoveredItem({ kind: 'badge', title: 'Product of the Day', text: 'Loomwork is Product of the Day.' }));
    const out = classifyDiscovered(si, PROFILE, now);
    expect(out!.mapping!.rule_id).toBe('N-badge-no-rule');
    expect(out!.mapping!.criteria).toEqual([1]);
    expect(out!.mapping!.status).toBe('needs_attorney');
  });

  it('an accepted review assignment is D-reviewer-judging, #4 qualifying', () => {
    const si = toSourceItem(discoveredItem({ kind: 'review_assignment', title: 'Reviewer assignment', text: 'Reviewer for ICML.', meta: { role: 'reviewer', venue: 'ICML', status: 'accepted' } }));
    const out = classifyDiscovered(si, PROFILE, now);
    expect(out!.mapping!.rule_id).toBe('D-reviewer-judging');
    expect(out!.mapping!.criteria).toEqual([4]);
    expect(out!.mapping!.status).toBe('qualifying');
  });

  it('a declined review assignment is C4-review-assignment-declined, building at most (E62)', () => {
    const si = toSourceItem(discoveredItem({ kind: 'review_assignment', title: 'Reviewer assignment', text: 'Reviewer for a venue she declined.', meta: { role: 'reviewer', venue: 'ICML', status: 'declined' } }));
    const out = classifyDiscovered(si, PROFILE, now);
    expect(out!.mapping!.rule_id).toBe('C4-review-assignment-declined');
    expect(out!.mapping!.status).toBe('building');
    expect(out!.mapping!.status).not.toBe('qualifying');
  });

  it('a Form D naming her company is D-form-d-funding, #8 qualifying, mentions #7 context', () => {
    const si = toSourceItem(discoveredItem({ kind: 'filing', title: 'Form D: Loomwork', text: 'Form D filed by Loomwork.', meta: { formType: 'D', issuerName: 'Loomwork' } }));
    const out = classifyDiscovered(si, PROFILE, now);
    expect(out!.mapping!.rule_id).toBe('D-form-d-funding');
    expect(out!.mapping!.criteria).toEqual([8]);
    expect(out!.mapping!.status).toBe('qualifying');
    expect(out!.mapping!.reason).toContain('#7');
  });

  it('a patent naming her as inventor is C5-patent, #5 qualifying', () => {
    const si = toSourceItem(discoveredItem({ kind: 'patent', title: 'Patent grant', text: 'Patent granted, Dara Voss listed as inventor.', meta: { status: 'granted', inventors: ['Dara Voss'] } }));
    const out = classifyDiscovered(si, PROFILE, now);
    expect(out!.mapping!.rule_id).toBe('C5-patent');
    expect(out!.mapping!.criteria).toEqual([5]);
    expect(out!.mapping!.status).toBe('qualifying');
  });

  it('a model at or above 10,000 downloads is C5-model-adoption qualifying', () => {
    const si = toSourceItem(discoveredItem({ kind: 'model', title: 'Model', text: 'Model: loomwork/flaky-ci-classifier', meta: { downloads: 25_000, likes: 100 } }));
    const out = classifyDiscovered(si, PROFILE, now);
    expect(out!.mapping!.rule_id).toBe('C5-model-adoption');
    expect(out!.mapping!.status).toBe('qualifying');
  });

  it('a model below 10,000 downloads is C5-model-adoption building', () => {
    const si = toSourceItem(discoveredItem({ kind: 'model', title: 'Model', text: 'Model: loomwork/tiny', meta: { downloads: 500, likes: 3 } }));
    const out = classifyDiscovered(si, PROFILE, now);
    expect(out!.mapping!.rule_id).toBe('C5-model-adoption');
    expect(out!.mapping!.status).toBe('building');
  });

  it('a third-party article or episode is #3 press from its own metadata (C3-discovered-press)', () => {
    const article = toSourceItem(discoveredItem({ kind: 'article', title: "Loomwork's Dara Voss wants to end flaky CI", text: "Article: Loomwork's Dara Voss wants to end flaky CI\nOutlet: techwire.example", author: { domain: 'techwire.example' } }));
    const episode = toSourceItem(discoveredItem({ kind: 'podcast_episode', title: 'Episode 12: Dara Voss of Loomwork', text: 'Episode 12: Dara Voss of Loomwork', author: { domain: 'shipitpod.example' } }));
    for (const item of [article, episode]) {
      const r = classifyDiscovered(item, PROFILE, now);
      expect(r?.mapping?.rule_id).toBe('C3-discovered-press');
      expect(r?.mapping?.criteria).toEqual([3]);
      expect(r?.mapping?.status).toBe('qualifying');
      expect(`${item.title}\n${item.text}`).toContain(r!.mapping!.quote);
    }
  });

  it("the trap rules still apply to discovered articles: the founder's own domain and press releases are never press", () => {
    const own = toSourceItem(discoveredItem({ kind: 'article', title: 'Dara Voss on Loomwork news', text: 'Article: Dara Voss on Loomwork news\nOutlet: loomwork.example', author: { domain: PROFILE.domain } }));
    const release = toSourceItem(discoveredItem({ kind: 'article', title: 'FOR IMMEDIATE RELEASE: Loomwork, led by Dara Voss, ships 2.0', text: 'Article: FOR IMMEDIATE RELEASE: Loomwork, led by Dara Voss, ships 2.0\nOutlet: prwire.example', author: { domain: 'prwire.example' } }));
    expect(classifyDiscovered(own, PROFILE, now)?.mapping?.rule_id).toBe('T-self-authored-not-press');
    expect(classifyDiscovered(release, PROFILE, now)?.mapping?.rule_id).toBe('T-press-release');
    expect(classifyDiscovered(release, PROFILE, now)?.mapping?.status).toBe('rejected');
  });
});

describe('GDELT adapter', () => {
  it('normalizes an article, mapping seendate to an ISO publishedAt and domain to author.domain', async () => {
    const adapter = createGdeltAdapter({ transport: new FixtureTransport(DISCOVERY_TIER1_FIXTURES) });
    const res = await adapter.discover(Q);
    expect(res.errors).toEqual([]);
    const found = res.items.find((i) => i.url === GDELT_ARTICLES.newFromGdelt.url);
    expect(found).toBeDefined();
    expect(found!.kind).toBe('article');
    expect(found!.author?.domain).toBe('techwire.example');
    expect(found!.publishedAt).toBe('2026-04-05T09:00:00Z');
    expect(found!.text).toContain('Dara Voss');
  });

  it('has accurate info (Tier 1, free, no key)', () => {
    const adapter = createGdeltAdapter({ transport: new FixtureTransport(DISCOVERY_TIER1_FIXTURES) });
    expect(adapter.info.id).toBe('gdelt');
    expect(adapter.info.tier).toBe(1);
    expect(adapter.info.credentials).toEqual([]);
  });
});

describe('Hugging Face adapter', () => {
  it('normalizes a model with downloads and likes for the founder handle', async () => {
    const adapter = createHuggingFaceAdapter({ transport: new FixtureTransport(DISCOVERY_TIER1_FIXTURES) });
    const res = await adapter.discover(Q);
    expect(res.errors).toEqual([]);
    const model = res.items.find((i) => i.externalId === `models/${HUGGINGFACE_MODEL.id}`);
    expect(model).toBeDefined();
    expect(model!.kind).toBe('model');
    expect(model!.meta.downloads).toBe(25_000);
    expect(model!.meta.likes).toBe(143);
  });
});

describe('discovery extension', () => {
  function ctxFor(adapters: DiscoveryAdapter[]): { ctx: ExtensionContext; ledger: ReturnType<typeof fakeLedger> } {
    const led = fakeLedger();
    const trace = { traceId: 'tr1', tool: () => {}, generation: () => {}, span: () => {} };
    const ctx = {
      deps: { ledger: led, profile: Q_PROFILE() } as unknown as ExtensionContext['deps'],
      trace: trace as unknown as ExtensionContext['trace'],
      runId: 'r1',
      now: new Date('2026-09-13T12:00:00Z'),
      binder: {} as ExtensionContext['binder'],
      context: {} as ExtensionContext['context'],
      summary: { degraded: [] } as unknown as ExtensionContext['summary'],
    };
    return { ctx, ledger: led };
  }

  function Q_PROFILE() {
    return { ...PROFILE, coauthors: ['Ren Park'], scanSince: '2026-01-01' };
  }

  function fakeLedger() {
    const events: { kind: string; detail: Record<string, unknown> }[] = [];
    const kv = new Map<string, string>();
    return {
      event: (e: { kind: string; detail: Record<string, unknown> }) => events.push(e),
      get: (k: string) => kv.get(k) ?? null,
      set: (k: string, v: string) => kv.set(k, v),
      candidates: () => [] as { url: string | null }[],
      _events: events,
    };
  }

  function adapterOf(items: DiscoveredItem[], overrides: Partial<DiscoveryAdapter> = {}): DiscoveryAdapter {
    return {
      info: { id: 'x', name: 'x', job: ['discover'], tier: 1, criteria: '#3', freeTier: 'free', credentials: [], receives: 'name' },
      discover: async () => ({ items, errors: [] }),
      ...overrides,
    };
  }

  it('rejects namesakes with a second_identifier_reject event and never returns them', async () => {
    const namesake = discoveredItem({ title: 'Chef Dara Voss', text: 'Dara Voss, the Lisbon chef.', url: 'https://x.example/1' });
    const { ctx, ledger } = ctxFor([adapterOf([namesake])]);
    registerDiscoveryClassifier(classifyDiscovered);
    const ext = createDiscoveryExtension({ adapters: [adapterOf([namesake])], alwaysRun: true });
    const out = await ext.discover!(ctx);
    expect(out).toEqual([]);
    expect(ledger._events.some((e) => e.kind === 'discovery' && e.detail.outcome === 'second_identifier_reject')).toBe(true);
  });

  it('degrades one adapter that throws without dropping the others', async () => {
    const good = discoveredItem({ title: 'Dara Voss of Loomwork', text: 'Dara Voss of Loomwork, a profile.', url: 'https://x.example/2' });
    const throwing = adapterOf([], { discover: async () => { throw new Error('boom'); } });
    const { ctx } = ctxFor([throwing, adapterOf([good])]);
    const ext = createDiscoveryExtension({ adapters: [throwing, adapterOf([good])], alwaysRun: true });
    const out = await ext.discover!(ctx);
    expect(out.length).toBe(1);
    expect(ctx.summary.degraded).toContain('x');
  });

  it('a limited adapter never advances its cadence key, so it is retried next run (E68)', async () => {
    const { ctx, ledger } = ctxFor([]);
    const limitedAdapter = adapterOf([], { discover: async () => ({ items: [], errors: [], limited: true }) });
    const ext = createDiscoveryExtension({ adapters: [limitedAdapter], alwaysRun: true });
    await ext.discover!(ctx);
    expect(ledger.get('discovery_last_run:x')).toBeNull();
  });

  it('a normal adapter run advances its cadence key', async () => {
    const { ctx, ledger } = ctxFor([]);
    const ext = createDiscoveryExtension({ adapters: [adapterOf([])], alwaysRun: true });
    await ext.discover!(ctx);
    expect(ledger.get('discovery_last_run:x')).not.toBeNull();
  });
});

describe('S21: discovery end to end', () => {
  it('passes all checks with no prohibited side effects', async () => {
    const result = await runScenarioAttempt(S21, 1);
    expect(result.error).toBeUndefined();
    const failing = result.checks.filter((c) => !c.pass);
    expect(failing).toEqual([]);
    expect(result.sideEffects).toEqual([]);
  });
});
