import { z } from 'zod';
import { createLiveApps, createLiveTwilio } from './apps/live/index.js';
import type { FeatureReport } from './apps/live/index.js';
import { argaApps, provisionArgaTwins, extend as argaExtend, teardown as argaTeardown } from '../harness/arga.js';
import type { ArgaRun } from '../harness/arga.js';
import type { AgentDeps, AgentExtension } from './agent.js';
import { FetchTransport } from './integrations/types.js';
import type { DiscoveryAdapter, VerifierAdapter } from './integrations/types.js';
import { Ledger } from './ledger.js';
import { McpWorthSendingGate } from './letters/worthSending.js';
import { AnthropicModel } from './models/anthropic.js';
import { HeuristicModel } from './models/heuristic.js';
import type { EvidenceModel } from './models/types.js';
import { createTracer } from './observability/tracer.js';
import { AnthropicResearcher, LiveFetcher } from './research/anthropic.js';
import { sourcePolicy } from './research/corroborator.js';
import type { Researcher, ResearchResult, WebFetcher } from './research/types.js';
import { loadGraph } from './rules/graph.js';
import type { FounderProfile } from './types.js';

export type { FeatureReport } from './apps/live/index.js';

// Wires AgentDeps for live mode (PRD 6 stack) and for a harness run against hosted Arga twins
// (PRD 7.1). Mirrors harness/env.ts, which does the same for the in-memory twins.

const RecommenderSchema = z.object({
  name: z.string(),
  email: z.string(),
  relationship: z.enum(['dependent', 'independent']),
  role: z.string(),
});

const FounderProfileSchema = z.object({
  name: z.string(),
  aliases: z.array(z.string()),
  emails: z.array(z.string()).min(1),
  domain: z.string(),
  company: z.string(),
  githubLogins: z.array(z.string()),
  ownAccounts: z.array(z.string()),
  linkedinId: z.string(),
  field: z.string(),
  targetFilingDate: z.string(),
  recommenderCandidates: z.array(RecommenderSchema),
}) satisfies z.ZodType<FounderProfile>;

function loadProfile(env: NodeJS.ProcessEnv): FounderProfile {
  const raw = env.EXHIBIT_PROFILE;
  if (!raw) throw new Error('buildLiveDeps: EXHIBIT_PROFILE is not set. Provide the founder profile as JSON (see .env.example).');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`buildLiveDeps: EXHIBIT_PROFILE is not valid JSON: ${String(err)}`);
  }
  const result = FounderProfileSchema.safeParse(parsed);
  if (!result.success) throw new Error(`buildLiveDeps: EXHIBIT_PROFILE does not match FounderProfile: ${result.error.message}`);
  return result.data;
}

function resolveModel(env: NodeJS.ProcessEnv): EvidenceModel {
  // The graph lets the mapper send the exact closed set of allowed rule ids (6.4).
  if (env.ANTHROPIC_API_KEY) return new AnthropicModel(env.ANTHROPIC_API_KEY, { modelId: env.EXHIBIT_MODEL ?? 'claude-sonnet-5', graph: loadGraph() });
  console.warn('buildLiveDeps: ANTHROPIC_API_KEY is not set; falling back to the heuristic classifier/mapper. Expect lower recall.');
  return new HeuristicModel();
}

/** No API key: never falls back to fixtures in live mode (PRD 6). Every exhibit stays unresearched. */
class NoKeyResearcher implements Researcher {
  readonly kind = 'anthropic' as const;
  async propose(): Promise<ResearchResult> {
    return { candidates: [], searches: 0, errors: ['no ANTHROPIC_API_KEY'] };
  }
}

function resolveResearcher(env: NodeJS.ProcessEnv): { researcher: Researcher; fetcher: WebFetcher } {
  const fetcher = new LiveFetcher();
  if (env.ANTHROPIC_API_KEY) return { researcher: new AnthropicResearcher(env.ANTHROPIC_API_KEY, env.EXHIBIT_MODEL ?? 'claude-sonnet-5'), fetcher };
  return { researcher: new NoKeyResearcher(), fetcher };
}

export interface LiveDepsResult {
  deps: AgentDeps;
  features: FeatureReport[];
  close(): Promise<void>;
}

/** A 6.13/6.14 feature module that may not exist yet in this checkout; import failure disables it rather than crashing. */
async function tryModule<M>(path: string): Promise<M | null> {
  try {
    return (await import(path)) as M;
  } catch {
    return null;
  }
}

interface DiscoveryModule {
  createDiscoveryExtension(opts: { adapters: DiscoveryAdapter[]; cadenceDays?: number; alwaysRun?: boolean }): AgentExtension;
}
interface TextChannelModule {
  createTextChannel(opts: { parser: unknown }): AgentExtension;
}
interface TextCommandsModule {
  HeuristicCommandParser: new () => unknown;
  AnthropicCommandParser: new (apiKey: string, graph: ReturnType<typeof loadGraph>, modelId?: string) => unknown;
}
interface StructuredModule {
  createStructuredResearch(opts: { adapters: VerifierAdapter[] }): unknown;
}
interface IntegrityModule {
  createIntegrityExtension(opts: {
    transport: FetchTransport;
    calendars?: string[];
    archiveKeys?: { accessKey: string; secretKey: string };
  }): AgentExtension;
}
interface SigningModule {
  createSigningExtension(opts: { client: unknown; dayMode: boolean }): AgentExtension;
}
interface DropboxSignModule {
  createDropboxSign(opts: { apiKey: string; transport: FetchTransport; testMode: boolean }): unknown;
}
interface TranslationModule {
  createTranslationExtension(opts: { client: unknown }): AgentExtension;
}
interface DeepLModule {
  createDeepL(opts: { apiKey: string; transport: FetchTransport }): unknown;
}

/** Discovery, verifier and integrity adapters (PRD 6.14): each on only when its own credentials are present. */
async function buildDiscoveryAdapters(env: NodeJS.ProcessEnv, transport: FetchTransport, features: FeatureReport[]): Promise<DiscoveryAdapter[]> {
  const adapters: DiscoveryAdapter[] = [];

  const [{ createHackerNewsAdapter }, gdeltMod, hfMod, { createProductHuntAdapter }, { createPodcastIndexAdapter }, { createUsptoAdapter }, { createOpenReviewAdapter }, { createOrcidAdapter }, { createEdgarAdapter }] =
    await Promise.all([
      import('./integrations/hackernews.js'),
      tryModule<{ createGdeltAdapter: (o: { transport: FetchTransport }) => DiscoveryAdapter }>('./integrations/gdelt.js'),
      tryModule<{ createHuggingFaceAdapter: (o: { transport: FetchTransport; token?: string }) => DiscoveryAdapter }>('./integrations/huggingface.js'),
      import('./integrations/producthunt.js'),
      import('./integrations/podcastindex.js'),
      import('./integrations/uspto.js'),
      import('./integrations/openreview.js'),
      import('./integrations/orcid.js'),
      import('./integrations/edgar.js'),
    ]);

  adapters.push(createHackerNewsAdapter({ transport }));
  features.push({ id: 'hackernews', enabled: true, reason: 'enabled' });

  if (gdeltMod) {
    adapters.push(gdeltMod.createGdeltAdapter({ transport }));
    features.push({ id: 'gdelt', enabled: true, reason: 'enabled' });
  } else {
    features.push({ id: 'gdelt', enabled: false, reason: 'disabled: module not built' });
  }

  if (hfMod) {
    adapters.push(hfMod.createHuggingFaceAdapter({ transport, token: env.HF_TOKEN }));
    features.push({ id: 'huggingface', enabled: true, reason: env.HF_TOKEN ? 'enabled' : 'enabled (unauthenticated, rate-limited)' });
  } else {
    features.push({ id: 'huggingface', enabled: false, reason: 'disabled: module not built' });
  }

  if (env.PRODUCTHUNT_TOKEN) {
    adapters.push(createProductHuntAdapter({ transport, token: env.PRODUCTHUNT_TOKEN }));
    features.push({ id: 'producthunt', enabled: true, reason: 'enabled' });
  } else {
    features.push({ id: 'producthunt', enabled: false, reason: 'disabled: PRODUCTHUNT_TOKEN missing' });
  }

  if (env.PODCASTINDEX_KEY && env.PODCASTINDEX_SECRET) {
    adapters.push(createPodcastIndexAdapter({ transport, apiKey: env.PODCASTINDEX_KEY, apiSecret: env.PODCASTINDEX_SECRET }));
    features.push({ id: 'podcastindex', enabled: true, reason: 'enabled' });
  } else {
    features.push({ id: 'podcastindex', enabled: false, reason: 'disabled: PODCASTINDEX_KEY/PODCASTINDEX_SECRET missing' });
  }

  if (env.USPTO_KEY) {
    adapters.push(createUsptoAdapter({ transport, apiKey: env.USPTO_KEY }));
    features.push({ id: 'uspto', enabled: true, reason: 'enabled' });
  } else {
    features.push({ id: 'uspto', enabled: false, reason: 'disabled: USPTO_KEY missing' });
  }

  if (env.OPENREVIEW_USERNAME && env.OPENREVIEW_PASSWORD) {
    adapters.push(createOpenReviewAdapter({ transport, username: env.OPENREVIEW_USERNAME, password: env.OPENREVIEW_PASSWORD }));
    features.push({ id: 'openreview', enabled: true, reason: 'enabled' });
  } else {
    features.push({ id: 'openreview', enabled: false, reason: 'disabled: OPENREVIEW_USERNAME/OPENREVIEW_PASSWORD missing' });
  }

  if (env.ORCID_CLIENT_ID && env.ORCID_CLIENT_SECRET && env.ORCID_ID) {
    adapters.push(createOrcidAdapter({ transport, orcidId: env.ORCID_ID, clientId: env.ORCID_CLIENT_ID, clientSecret: env.ORCID_CLIENT_SECRET }));
    features.push({ id: 'orcid', enabled: true, reason: 'enabled' });
  } else {
    features.push({ id: 'orcid', enabled: false, reason: 'disabled: ORCID_CLIENT_ID/ORCID_CLIENT_SECRET/ORCID_ID missing' });
  }

  if (env.SEC_EDGAR_USER_AGENT) {
    adapters.push(createEdgarAdapter({ transport, userAgent: env.SEC_EDGAR_USER_AGENT }));
    features.push({ id: 'edgar', enabled: true, reason: 'enabled' });
  } else {
    features.push({ id: 'edgar', enabled: false, reason: 'disabled: SEC_EDGAR_USER_AGENT missing' });
  }

  return adapters;
}

async function buildVerifierAdapters(env: NodeJS.ProcessEnv, transport: FetchTransport, features: FeatureReport[]): Promise<VerifierAdapter[]> {
  const adapters: VerifierAdapter[] = [];
  const [{ createOpenAlexAdapter }, { createCrossrefAdapter }, { createSemanticScholarAdapter }, { createBlsAdapter }, { createOnetAdapter }, { createEcosystemsAdapter }, { createPlatformStatsAdapter }] = await Promise.all([
    import('./integrations/openalex.js'),
    import('./integrations/crossref.js'),
    import('./integrations/semanticscholar.js'),
    import('./integrations/bls.js'),
    import('./integrations/onet.js'),
    import('./integrations/ecosystems.js'),
    import('./integrations/platformstats.js'),
  ]);

  if (env.OPENALEX_KEY) {
    adapters.push(createOpenAlexAdapter({ transport, apiKey: env.OPENALEX_KEY, mailto: env.CROSSREF_MAILTO ?? '' }));
    features.push({ id: 'openalex', enabled: true, reason: 'enabled' });
  } else {
    features.push({ id: 'openalex', enabled: false, reason: 'disabled: OPENALEX_KEY missing' });
  }

  if (env.CROSSREF_MAILTO) {
    adapters.push(createCrossrefAdapter({ transport, mailto: env.CROSSREF_MAILTO }));
    features.push({ id: 'crossref', enabled: true, reason: 'enabled' });
  } else {
    features.push({ id: 'crossref', enabled: false, reason: 'disabled: CROSSREF_MAILTO missing' });
  }

  // Semantic Scholar works unauthenticated but at a much lower rate limit; on either way, key optional.
  adapters.push(createSemanticScholarAdapter({ transport, apiKey: env.SEMANTIC_SCHOLAR_KEY }));
  features.push({ id: 'semanticscholar', enabled: true, reason: env.SEMANTIC_SCHOLAR_KEY ? 'enabled' : 'enabled (unauthenticated, rate-limited)' });

  if (env.BLS_KEY) {
    adapters.push(createBlsAdapter({ transport, registrationKey: env.BLS_KEY }));
    features.push({ id: 'bls', enabled: true, reason: 'enabled' });
  } else {
    features.push({ id: 'bls', enabled: false, reason: 'disabled: BLS_KEY missing' });
  }

  if (env.ONET_USERNAME && env.ONET_PASSWORD) {
    adapters.push(createOnetAdapter({ transport, username: env.ONET_USERNAME, key: env.ONET_PASSWORD }));
    features.push({ id: 'onet', enabled: true, reason: 'enabled' });
  } else {
    features.push({ id: 'onet', enabled: false, reason: 'disabled: ONET_USERNAME/ONET_PASSWORD missing' });
  }

  // ecosyste.ms needs no key.
  adapters.push(createEcosystemsAdapter({ transport }));
  features.push({ id: 'ecosystems', enabled: true, reason: 'enabled' });

  adapters.push(createPlatformStatsAdapter({ transport, githubToken: env.GITHUB_TOKEN, huggingFaceToken: env.HF_TOKEN }));
  features.push({ id: 'platformstats', enabled: true, reason: env.GITHUB_TOKEN ? 'enabled' : 'enabled (no GITHUB_TOKEN; lower rate limit)' });

  return adapters;
}

async function buildExtensions(env: NodeJS.ProcessEnv, features: FeatureReport[]): Promise<AgentExtension[]> {
  const extensions: AgentExtension[] = [];
  const transport = new FetchTransport();

  // 1. discovery
  const discoveryMod = await tryModule<DiscoveryModule>('./discovery/extension.js');
  if (discoveryMod) {
    const adapters = await buildDiscoveryAdapters(env, transport, features);
    extensions.push(discoveryMod.createDiscoveryExtension({ adapters }));
  } else {
    features.push({ id: 'discovery', enabled: false, reason: 'disabled: module not built' });
  }

  // 2. text channel (Twilio 6.13)
  const { api: twilioApi, feature: twilioFeature } = createLiveTwilio(env);
  features.push(twilioFeature);
  const [channelMod, commandsMod] = await Promise.all([tryModule<TextChannelModule>('./text/channel.js'), tryModule<TextCommandsModule>('./text/commands.js')]);
  if (channelMod && commandsMod && twilioApi) {
    const parser = env.ANTHROPIC_API_KEY ? new commandsMod.AnthropicCommandParser(env.ANTHROPIC_API_KEY, loadGraph(), env.EXHIBIT_MODEL ?? 'claude-sonnet-5') : new commandsMod.HeuristicCommandParser();
    extensions.push(channelMod.createTextChannel({ parser }));
    features.push({ id: 'text-channel', enabled: true, reason: 'enabled' });
  } else {
    const why = !channelMod || !commandsMod ? 'module not built' : 'TWILIO_* missing';
    features.push({ id: 'text-channel', enabled: false, reason: `disabled: ${why}` });
  }

  // 3. integrity (timestamping)
  const integrityMod = await tryModule<IntegrityModule>('./integrity/extension.js');
  if (integrityMod) {
    const archiveKeys = env.IA_ACCESS_KEY && env.IA_SECRET_KEY ? { accessKey: env.IA_ACCESS_KEY, secretKey: env.IA_SECRET_KEY } : undefined;
    extensions.push(integrityMod.createIntegrityExtension({ transport, archiveKeys }));
    features.push({ id: 'integrity', enabled: true, reason: 'enabled' });
    features.push({ id: 'integrity-archive', enabled: !!archiveKeys, reason: archiveKeys ? 'enabled' : 'disabled: IA_ACCESS_KEY/IA_SECRET_KEY missing' });
  } else {
    features.push({ id: 'integrity', enabled: false, reason: 'disabled: module not built' });
  }

  // 4. signing (Dropbox Sign) -- day mode (test mode + controlled signers only) unless both
  // DROPBOX_SIGN_TEST_MODE=0 and EXHIBIT_ALLOW_LIVE_SIGNATURES=1 explicitly opt into live signatures.
  const [signingMod, dropboxSignMod] = await Promise.all([tryModule<SigningModule>('./letters/signing.js'), tryModule<DropboxSignModule>('./integrations/dropboxsign.js')]);
  if (signingMod && dropboxSignMod && env.DROPBOX_SIGN_API_KEY) {
    const liveSignaturesEnabled = env.DROPBOX_SIGN_TEST_MODE === '0' && env.EXHIBIT_ALLOW_LIVE_SIGNATURES === '1';
    const dayMode = !liveSignaturesEnabled;
    const client = dropboxSignMod.createDropboxSign({ apiKey: env.DROPBOX_SIGN_API_KEY, transport, testMode: dayMode });
    extensions.push(signingMod.createSigningExtension({ client, dayMode }));
    features.push({ id: 'signing', enabled: true, reason: liveSignaturesEnabled ? 'enabled (live signatures)' : 'enabled (test mode)' });
  } else {
    const why = !signingMod || !dropboxSignMod ? 'module not built' : 'DROPBOX_SIGN_API_KEY missing';
    features.push({ id: 'signing', enabled: false, reason: `disabled: ${why}` });
  }

  // 5. translation (DeepL) -- only when the founder opted a source in.
  const [translationMod, deeplMod] = await Promise.all([tryModule<TranslationModule>('./translate/translate.js'), tryModule<DeepLModule>('./integrations/deepl.js')]);
  if (translationMod && deeplMod && env.DEEPL_KEY) {
    const client = deeplMod.createDeepL({ apiKey: env.DEEPL_KEY, transport });
    extensions.push(translationMod.createTranslationExtension({ client }));
    features.push({ id: 'translation', enabled: true, reason: 'enabled' });
  } else {
    const why = !translationMod || !deeplMod ? 'module not built' : 'DEEPL_KEY missing';
    features.push({ id: 'translation', enabled: false, reason: `disabled: ${why}` });
  }

  // 6. notifier (proactive texts + weekly digest); depends only on ledger/profile/apps, always on.
  const notifierMod = await tryModule<{ createNotifier(opts?: { sundayHourLocal?: number }): AgentExtension }>('./notify/notifier.js');
  if (notifierMod) {
    extensions.push(notifierMod.createNotifier());
    features.push({ id: 'notifier', enabled: true, reason: 'enabled' });
  } else {
    features.push({ id: 'notifier', enabled: false, reason: 'disabled: module not built' });
  }

  return extensions;
}

async function buildStructuredResearch(env: NodeJS.ProcessEnv, features: FeatureReport[]): Promise<AgentDeps['structured']> {
  const structuredMod = await tryModule<StructuredModule>('./research/structured.js');
  if (!structuredMod) {
    features.push({ id: 'structured-research', enabled: false, reason: 'disabled: module not built' });
    return undefined;
  }
  const transport = new FetchTransport();
  const adapters = await buildVerifierAdapters(env, transport, features);
  features.push({ id: 'structured-research', enabled: true, reason: 'enabled' });
  return structuredMod.createStructuredResearch({ adapters }) as AgentDeps['structured'];
}

export async function buildLiveDeps(env: NodeJS.ProcessEnv): Promise<LiveDepsResult> {
  const profile = loadProfile(env);
  const apps = createLiveApps(env);
  const ledger = new Ledger(env.EXHIBIT_LEDGER ?? '.exhibit/ledger.db');
  const tracer = createTracer(env, '.exhibit/traces');
  const model = resolveModel(env);
  const { researcher, fetcher } = resolveResearcher(env);
  const gate = new McpWorthSendingGate();
  const graph = loadGraph();

  const features: FeatureReport[] = [];
  // Deliberate order: discovery -> text channel -> integrity -> signing -> translation -> notifier (PRD 6).
  const extensions = await buildExtensions(env, features);
  const structured = await buildStructuredResearch(env, features);

  const deps: AgentDeps = {
    apps,
    ledger,
    tracer,
    profile,
    model,
    graph,
    researcher,
    fetcher,
    policy: sourcePolicy(graph, false),
    gate,
    clock: { now: () => new Date() },
    release: env.LEMMA_RELEASE ?? 'dev',
    extend: async () => {},
    mode: 'watch',
    extensions,
    structured,
  };

  return {
    deps,
    features,
    async close() {
      await gate.close();
      ledger.close();
    },
  };
}

export interface ArgaDepsOptions {
  scenarioId?: string;
  twins?: string[];
  ttlMinutes?: number;
  profile?: FounderProfile;
}

export interface ArgaDepsResult {
  deps: AgentDeps;
  run: ArgaRun;
  close(): Promise<void>;
}

/** Wires AgentDeps for a harness run against hosted Arga twins rather than the in-memory ones (PRD 7.1). */
export async function buildArgaDeps(env: NodeJS.ProcessEnv, opts: ArgaDepsOptions = {}): Promise<ArgaDepsResult> {
  const apiKey = env.ARGA_API_KEY;
  if (!apiKey) throw new Error('buildArgaDeps: ARGA_API_KEY is not set.');
  const profile = opts.profile ?? loadProfile(env);
  const owner = profile.emails[0]!;

  const run = await provisionArgaTwins({ apiKey, twins: opts.twins, ttlMinutes: opts.ttlMinutes, scenarioId: opts.scenarioId, baseUrl: env.ARGA_BASE_URL });
  const apps = argaApps(run, owner, profile);

  const ledger = new Ledger(env.EXHIBIT_LEDGER ?? ':memory:');
  const tracer = createTracer(env, env.EXHIBIT_TRACE_DIR ?? null);
  const model = resolveModel(env);
  const { researcher, fetcher } = resolveResearcher(env);
  const gate = new McpWorthSendingGate();
  const graph = loadGraph();

  const deps: AgentDeps = {
    apps,
    ledger,
    tracer,
    profile,
    model,
    graph,
    researcher,
    fetcher,
    policy: sourcePolicy(graph, false),
    gate,
    clock: { now: () => new Date() },
    release: env.LEMMA_RELEASE ?? 'dev',
    extend: () => argaExtend(apiKey, run.runId, { baseUrl: env.ARGA_BASE_URL }),
    mode: 'harness',
    scenarioId: opts.scenarioId ?? null,
  };

  return {
    deps,
    run,
    async close() {
      await gate.close();
      ledger.close();
      await argaTeardown(apiKey, run.runId, { baseUrl: env.ARGA_BASE_URL });
    },
  };
}
