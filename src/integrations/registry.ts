import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The 6.14 integration table as one registry (reliability brief §2, Appendix A `integrations_built`
// / `integrations_not_built`): a service is "built" only if its module file is on disk and exports
// something that looks like an adapter or extension, "exercised" only from a real integration_call
// event with a fixture transport, and "used live" only from one with a live transport (constraint 19:
// never claim live without a live event). USCIS is always sandbox-only regardless of events.

export type IntegrationState = 'used_live' | 'exercised_with_fixtures' | 'built_not_exercised' | 'specified_not_built';

export interface RegistryEntry {
  id: string;
  name: string;
  /** Candidate module paths (relative to repo root); first one found on disk wins. */
  modulePaths: string[];
}

export interface IntegrationStatusRow {
  id: string;
  name: string;
  modulePath: string | null;
  state: IntegrationState;
  note?: string;
}

const ROOT = process.cwd();

export const INTEGRATION_MODULES: RegistryEntry[] = [
  { id: 'gdelt', name: 'GDELT', modulePaths: ['src/integrations/gdelt.ts'] },
  { id: 'huggingface', name: 'Hugging Face Hub', modulePaths: ['src/integrations/huggingface.ts'] },
  { id: 'hackernews', name: 'Hacker News', modulePaths: ['src/integrations/hackernews.ts'] },
  { id: 'producthunt', name: 'Product Hunt', modulePaths: ['src/integrations/producthunt.ts'] },
  { id: 'podcastindex', name: 'Podcast Index', modulePaths: ['src/integrations/podcastindex.ts'] },
  { id: 'uspto', name: 'USPTO PatentSearch', modulePaths: ['src/integrations/uspto.ts'] },
  { id: 'openreview', name: 'OpenReview', modulePaths: ['src/integrations/openreview.ts'] },
  { id: 'orcid', name: 'ORCID', modulePaths: ['src/integrations/orcid.ts'] },
  { id: 'edgar', name: 'SEC EDGAR (Form D)', modulePaths: ['src/integrations/edgar.ts'] },
  { id: 'openalex', name: 'OpenAlex', modulePaths: ['src/integrations/openalex.ts'] },
  { id: 'crossref', name: 'Crossref', modulePaths: ['src/integrations/crossref.ts'] },
  { id: 'semanticscholar', name: 'Semantic Scholar', modulePaths: ['src/integrations/semanticscholar.ts'] },
  { id: 'bls', name: 'BLS (90th-percentile wage)', modulePaths: ['src/integrations/bls.ts'] },
  { id: 'onet', name: 'O*NET', modulePaths: ['src/integrations/onet.ts'] },
  { id: 'ecosystems', name: 'ecosyste.ms', modulePaths: ['src/integrations/ecosystems.ts'] },
  { id: 'platformstats', name: 'Platform stats (GitHub/Google plumbing)', modulePaths: ['src/integrations/platformstats.ts'] },
  { id: 'opentimestamps', name: 'OpenTimestamps', modulePaths: ['src/integrity/opentimestamps.ts', 'src/integrity/ots.ts'] },
  { id: 'archive', name: 'Internet Archive Save Page Now', modulePaths: ['src/integrity/archive.ts'] },
  { id: 'dropboxsign', name: 'Dropbox Sign', modulePaths: ['src/integrations/dropboxsign.ts'] },
  { id: 'deepl', name: 'DeepL API Free', modulePaths: ['src/integrations/deepl.ts'] },
  { id: 'twilio', name: 'Twilio (text channel)', modulePaths: ['src/apps/live/twilio.ts'] },
  { id: 'textchannel', name: 'Text command channel', modulePaths: ['src/text/channel.ts', 'src/text/commands.ts'] },
  { id: 'structuredresearch', name: 'Structured research dispatch', modulePaths: ['src/research/structured.ts'] },
  { id: 'uscis', name: 'USCIS Case Status API (Torch)', modulePaths: ['src/integrations/uscis.ts'] },
];

function findModule(entry: RegistryEntry): string | null {
  for (const rel of entry.modulePaths) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, 'utf8');
    // Looks like an adapter/extension: exports something and isn't an empty stub.
    if (/export\s+(const|function|class|default)/.test(text)) return rel;
  }
  return null;
}

/**
 * Classify each registered integration from ledger `integration_call` events (id: `{integration,
 * op, ok, transport}`). Events come from harness/runner.ts AttemptMetrics.events, already bounded.
 */
export function integrationStatus(events: { kind: string; detail: Record<string, unknown> }[]): IntegrationStatusRow[] {
  const calls = events.filter((e) => e.kind === 'integration_call');
  const byIntegration = new Map<string, { live: boolean; fixture: boolean }>();
  for (const c of calls) {
    const id = String(c.detail.integration ?? '');
    if (!id) continue;
    const cur = byIntegration.get(id) ?? { live: false, fixture: false };
    if (c.detail.transport === 'live') cur.live = true;
    if (c.detail.transport === 'fixture') cur.fixture = true;
    byIntegration.set(id, cur);
  }

  return INTEGRATION_MODULES.map((entry) => {
    const modulePath = findModule(entry);
    if (entry.id === 'uscis') {
      return { id: entry.id, name: entry.name, modulePath, state: modulePath ? 'built_not_exercised' : 'specified_not_built', note: 'Sandbox client only; production access pending USCIS approval.' } as IntegrationStatusRow;
    }
    if (!modulePath) return { id: entry.id, name: entry.name, modulePath: null, state: 'specified_not_built' };
    const seen = byIntegration.get(entry.id);
    if (seen?.live) return { id: entry.id, name: entry.name, modulePath, state: 'used_live' };
    if (seen?.fixture) return { id: entry.id, name: entry.name, modulePath, state: 'exercised_with_fixtures' };
    return { id: entry.id, name: entry.name, modulePath, state: 'built_not_exercised' };
  });
}

export function summarizeIntegrations(rows: IntegrationStatusRow[]): { built: string[]; notBuilt: string[] } {
  return {
    built: rows.filter((r) => r.state !== 'specified_not_built').map((r) => r.name),
    notBuilt: rows.filter((r) => r.state === 'specified_not_built').map((r) => r.name),
  };
}

// ---------------- live-smoke status (constraint 19) ----------------
//
// Transcribed from docs/integrations/LIVE-SMOKE.md's per-service verdict (smoke run recorded
// 2026-09-13T17:32:21.900Z). That file is a point-in-time report of one manual smoke pass, not a
// machine-readable ledger, so this table is hand-transcribed rather than parsed -- every `live` /
// `note` below traces to a specific verdict cell in that file. "Live" here always means "smoke: one
// request, keyless" (constraint 19), never "in production".
export interface LiveSmokeRow {
  id: string;
  live: boolean;
  note: string;
}

export const LIVE_SMOKE_STATUS: LiveSmokeRow[] = [
  { id: 'gdelt', live: true, note: 'ran only on an empty result (0 hits); not a positive live parse' },
  { id: 'hackernews', live: true, note: 'exercised live' },
  { id: 'crossref', live: true, note: 'exercised live' },
  { id: 'semanticscholar', live: false, note: 'inconclusive: 200 response but the parser found no candidates; not confirmed live, needs a clean re-run' },
  { id: 'ecosystems', live: true, note: 'exercised live' },
  { id: 'platformstats', live: true, note: 'GitHub REST leg only; the Hugging Face leg was not exercised' },
  { id: 'bls', live: true, note: 'exercised live, unregistered-key path' },
  { id: 'archive', live: true, note: 'availability API only; Save Page Now was not called' },
  { id: 'opentimestamps', live: true, note: 'single-calendar smoke only (one of three DEFAULT_CALENDARS); upgrade/verifyProof not exercised' },
];

export function liveSmokeStatusFor(id: string): LiveSmokeRow | undefined {
  return LIVE_SMOKE_STATUS.find((r) => r.id === id);
}

export type BriefIntegrationCategory = 'sandbox_only' | 'exercised_live_smoke' | 'built_fixture_tested' | 'not_run_live';

export interface BriefIntegrationRow extends IntegrationStatusRow {
  category: BriefIntegrationCategory;
  smokeNote?: string;
}

/**
 * Section 2's four-way split (registry state plus docs/integrations/LIVE-SMOKE.md): built and
 * fixture-tested; exercised live (smoke); not run live; sandbox only (USCIS). USCIS always wins
 * (it is sandbox-only regardless of any event), then a recorded live-smoke pass, then this batch's
 * own fixture-transport events, then "not run live" for everything else -- including a module that
 * doesn't exist on disk yet, which gets an explicit note rather than being silently dropped.
 */
export function categorizeForBrief(rows: IntegrationStatusRow[]): BriefIntegrationRow[] {
  return rows.map((r) => {
    if (r.id === 'uscis') return { ...r, category: 'sandbox_only' };
    const smoke = liveSmokeStatusFor(r.id);
    if (smoke?.live) return { ...r, category: 'exercised_live_smoke', smokeNote: smoke.note };
    if (r.state === 'exercised_with_fixtures') return { ...r, category: 'built_fixture_tested', smokeNote: smoke?.note };
    if (!r.modulePath) return { ...r, category: 'not_run_live', smokeNote: 'module not found on disk' };
    return { ...r, category: 'not_run_live', smokeNote: smoke?.note };
  });
}
