import type { AgentExtension } from '../src/agent.js';
import { createDiscoveryExtension } from '../src/discovery/extension.js';
import { createEdgarAdapter } from '../src/integrations/edgar.js';
import { createGdeltAdapter } from '../src/integrations/gdelt.js';
import { createHackerNewsAdapter } from '../src/integrations/hackernews.js';
import { createHuggingFaceAdapter } from '../src/integrations/huggingface.js';
import { createOpenReviewAdapter } from '../src/integrations/openreview.js';
import { createOrcidAdapter } from '../src/integrations/orcid.js';
import { createPodcastIndexAdapter } from '../src/integrations/podcastindex.js';
import { createProductHuntAdapter } from '../src/integrations/producthunt.js';
import { createUsptoAdapter } from '../src/integrations/uspto.js';
import { createBlsAdapter } from '../src/integrations/bls.js';
import { createCrossrefAdapter } from '../src/integrations/crossref.js';
import { createEcosystemsAdapter } from '../src/integrations/ecosystems.js';
import { createOnetAdapter } from '../src/integrations/onet.js';
import { createOpenAlexAdapter } from '../src/integrations/openalex.js';
import { createPlatformStatsAdapter } from '../src/integrations/platformstats.js';
import { createSemanticScholarAdapter } from '../src/integrations/semanticscholar.js';
import type { FixtureMap } from '../src/integrations/types.js';
import { FixtureTransport } from '../src/integrations/types.js';
import { createIntegrityExtension } from '../src/integrity/extension.js';
import { createSigningExtension } from '../src/letters/signing.js';
import { createNotifier } from '../src/notify/notifier.js';
import { createStructuredResearch } from '../src/research/structured.js';
import { createTextChannel } from '../src/text/channel.js';
import { HeuristicCommandParser } from '../src/text/commands.js';
import { createTranslationExtension } from '../src/translate/translate.js';
import { MemoryDeepL, MemoryDropboxSign } from '../src/twins/fakes.js';
import { MemoryTwilio } from '../src/twins/twilio.js';
import { DISCOVERY_TIER1_FIXTURES } from './fixtures/discovery-tier1.js';
import { DISCOVERY_TIER2A_FIXTURES } from './fixtures/discovery-tier2a.js';
import { DARA_VOSS_ORCID, DARA_VOSS_OPENREVIEW_PROFILE, EDGAR_FIXTURES, OPENREVIEW_FIXTURES, OPENREVIEW_VENUES, ORCID_FIXTURES } from './fixtures/discovery-tier2b.js';
import { createIntegrityFixtures } from './fixtures/integrity.js';
import { VERIFIER_API_FIXTURES } from './fixtures/verifier-apis.js';
import type { HarnessEnv, HarnessEnvOptions } from './env.js';

// The full-stack preset (PRD 6.13, 6.14): turns on every 6.13/6.14 AgentExtension at once, wired to
// fixture transports so the whole stack runs deterministically offline, in the fixed order agent.ts
// runs its hooks in (discover -> beforeClassify -> afterFiling -> afterReview -> afterLetters ->
// afterScorecard): discovery, text channel, integrity, signing, translation, notifier.
//
// Every extension name below is the AgentExtension#name each factory returns (src/discovery/extension.ts,
// src/text/channel.ts, src/integrity/extension.ts, src/letters/signing.ts, src/translate/translate.ts,
// src/notify/notifier.ts): 'discovery', 'text-channel', 'integrity', 'signing', 'translation', 'notifier'.
export const FULL_STACK_EXTENSION_NAMES = ['discovery', 'text-channel', 'integrity', 'signing', 'translation', 'notifier'] as const;
export type FullStackExtensionName = (typeof FULL_STACK_EXTENSION_NAMES)[number];

export interface FullStackFeatures {
  /** Extension names actually included in this build, in run order. */
  included: FullStackExtensionName[];
  /** Extension names requested (or available) but excluded by `opts.only`. */
  missing: FullStackExtensionName[];
}

/**
 * Merges any number of FixtureMap-shaped objects (plain objects or the Proxy-backed integrity
 * fixtures) into one lookup, checked in order. FixtureTransport only ever does `fixtures[key]`, so
 * a lazy Proxy composes correctly here even though `{...proxyFixtures}` would silently drop every
 * entry (the integrity fixtures' keys are pattern-matched in a `get` trap, not enumerable own
 * properties -- see harness/fixtures/integrity.ts). Every source map here is namespaced by host
 * already (`METHOD https://<distinct-api-host>/...`), so no key ever needs rewriting to avoid a
 * collision between two different integrations.
 */
export function mergeFixtures(...maps: FixtureMap[]): FixtureMap {
  return new Proxy({} as FixtureMap, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      for (const m of maps) {
        const hit = m[prop];
        if (hit !== undefined) return hit;
      }
      return undefined;
    },
  });
}

export interface FullStackOptions {
  /** Restrict the build to exactly these extension names; omit for every available extension. */
  only?: string[];
}

function want(opts: FullStackOptions | undefined, name: FullStackExtensionName): boolean {
  return !opts?.only || opts.only.includes(name);
}

/** What `fullStack(opts)` would build, without building it -- included vs available-but-excluded. */
export function fullStackFeatures(opts?: FullStackOptions): FullStackFeatures {
  const included = FULL_STACK_EXTENSION_NAMES.filter((n) => want(opts, n));
  const missing = FULL_STACK_EXTENSION_NAMES.filter((n) => !want(opts, n));
  return { included, missing };
}

/**
 * One HarnessEnvOptions fragment turning on every 6.13/6.14 AgentExtension at once, all wired to
 * fixture transports (never live). Spread into createHarnessEnv / Scenario.env, e.g.:
 *
 *   env: { ...fullStack() }
 *
 * `opts.only` restricts to a subset of FULL_STACK_EXTENSION_NAMES (e.g. `{ only: ['discovery'] }`)
 * for isolating which extension breaks a scenario; call `fullStackFeatures(opts)` separately for the
 * included/missing report.
 */
export function fullStack(opts?: FullStackOptions): Pick<HarnessEnvOptions, 'extensions' | 'twilio' | 'structured'> {
  const transport = new FixtureTransport(
    mergeFixtures(DISCOVERY_TIER1_FIXTURES, DISCOVERY_TIER2A_FIXTURES, OPENREVIEW_FIXTURES, ORCID_FIXTURES, EDGAR_FIXTURES, VERIFIER_API_FIXTURES, createIntegrityFixtures().fixtures),
  );

  // A second, independent integrity-fixtures instance backs the integrity extension itself so its
  // stateful helpers (markUpgraded/blockHeaders) stay internally consistent; its `.fixtures` Proxy is
  // also folded into the merged transport above so every calendar/archive URL resolves the same way
  // whichever call site (integrity extension or a direct fetch) uses `transport`.
  const integrityFixtures = createIntegrityFixtures();

  const structured = createStructuredResearch({
    adapters: [
      createPlatformStatsAdapter({ transport }),
      createEcosystemsAdapter({ transport }),
      createOpenAlexAdapter({ transport, mailto: 'evidence@loomwork.example', apiKey: 'test-key' }),
      createCrossrefAdapter({ transport, mailto: 'evidence@loomwork.example' }),
      createSemanticScholarAdapter({ transport }),
      createBlsAdapter({ transport, registrationKey: 'test-key' }),
      createOnetAdapter({ transport, key: 'test-key' }),
    ],
  });

  const extensions = (env: HarnessEnv): AgentExtension[] => {
    const out: AgentExtension[] = [];

    if (want(opts, 'discovery')) {
      out.push(
        createDiscoveryExtension({
          alwaysRun: true, // harness mode: ignore the 7-day live cadence so every run exercises discovery
          transportKind: 'fixture',
          adapters: [
            createGdeltAdapter({ transport }),
            createHuggingFaceAdapter({ transport }),
            createHackerNewsAdapter({ transport }),
            createProductHuntAdapter({ transport, token: 'test-token' }),
            createPodcastIndexAdapter({ transport, apiKey: 'test-key', apiSecret: 'test-secret', now: () => env.clock.now().getTime() }),
            createUsptoAdapter({ transport, apiKey: 'test-key' }),
            createOpenReviewAdapter({ transport, username: 'dara@loomwork.example', password: 'test-password', profileId: DARA_VOSS_OPENREVIEW_PROFILE, venues: [...OPENREVIEW_VENUES] }),
            createOrcidAdapter({ transport, orcidId: DARA_VOSS_ORCID, clientId: 'test-client', clientSecret: 'test-secret' }),
            createEdgarAdapter({ transport, userAgent: 'Exhibit evidence agent contact@loomwork.example' }),
          ],
        }),
      );
    }

    if (want(opts, 'text-channel')) {
      out.push(createTextChannel({ parser: new HeuristicCommandParser() }));
    }

    if (want(opts, 'integrity')) {
      out.push(
        createIntegrityExtension({
          transport,
          archiveKeys: { accessKey: 'test-access', secretKey: 'test-secret' },
          blockHeaders: integrityFixtures.blockHeaders,
        }),
      );
    }

    if (want(opts, 'signing')) {
      out.push(
        createSigningExtension({
          client: new MemoryDropboxSign({ testMode: true, now: () => env.clock.now(), record: (a, o, ac, d) => env.twins.recordOp(a, o, ac, d) }),
          dayMode: true,
        }),
      );
    }

    if (want(opts, 'translation')) {
      out.push(createTranslationExtension({ client: new MemoryDeepL({ record: (a, o, ac, d) => env.twins.recordOp(a, o, ac, d) }) }));
    }

    if (want(opts, 'notifier')) {
      out.push(createNotifier());
    }

    return out;
  };

  return {
    extensions,
    twilio: want(opts, 'text-channel')
      ? (env: HarnessEnv) => new MemoryTwilio({ sender: 'whatsapp:+15550009999', now: () => env.clock.now(), record: (a, o, ac, d) => env.twins.recordOp(a, o, ac, d) })
      : undefined,
    structured,
  };
}
