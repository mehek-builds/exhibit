import type { TwinSeed } from '../src/twins/memory.js';
import type { FounderProfile } from '../src/types.js';

// Converts a scenario's in-memory TwinSeed (src/twins/memory.ts) into a `seed_config` payload for
// `client.scenarios.create({ seedConfig, ... })` (PRD 7.1, 7.5, 12.3): "Seeding: the synthetic year
// for Dara Voss as `seed_config` per twin."
//
// SEEDING PATH (confirmed 2026-09-13): the installed arga-sdk's `ProvisionTwinsParams` (the
// `client.twins.provision` params) has NO `seedConfig` field -- only `scenarioId`/`scenarioPrompt`
// for server-side generation (node_modules/arga-sdk/dist/index.d.ts). But `CreateScenarioParams`
// (`client.scenarios.create`) DOES declare `seedConfig?: Record<string, unknown>`, and
// https://docs.argalabs.com/features/custom-scenarios confirms it's real and keyed per twin, e.g.:
//   { "slack": { "channels": [...] }, "stripe": { "customers": [...] } }
// -- "Each twin provider ... contains its own nested configuration object with provider-specific
// fields." harness/arga-backend.ts now seeds through `scenarios.create` + `ensureTwinEnvironment`,
// not `twins.provision`. This file builds that `seedConfig` object; `toArgaSeedConfig`'s return
// value is passed straight through.
//
// TWIN KEYS (confirmed 2026-09-13 from https://docs.argalabs.com/concepts/twin-reference): Arga's
// documented twin identifiers are underscored, not hyphenated -- `google_calendar`, `google_drive`,
// `google_docs`, `google_sheets`. `gmail` is a real, separately-documented twin ("Gmail API
// workflows for inboxes, threads, messages, drafts, labels, attachments, search, send behavior, and
// watch events"). `linkedin` is NOT a documented Arga twin at all (absent from both
// concepts/twin-reference and concepts/digital-twins) -- there is nothing to seed it with, so it is
// omitted from the returned config; LinkedIn scenarios must read from seeded fixtures instead (PRD
// 7.1 Team-plan fallback), not an Arga twin.
//
// STILL UNCONFIRMED at the event (checklist item, docs/ARGA.md): the exact per-field schema inside
// each twin's block for gmail/google_calendar/google_drive/google_docs/google_sheets/github --
// docs.argalabs.com/features/custom-scenarios only shows worked examples for slack/stripe/github,
// not the Google Workspace or Gmail twins, and docs.argalabs.com/features/google-workspace-cli
// documents the `gws` CLI's Discovery-document approach without stating seed_config field names.
// The load-bearing guarantee that IS confirmed: Gmail messages seed from raw RFC 822
// (`GmailMessage.raw`, built by `buildEml` in src/twins/memory.ts) is the only spelling PRD 7.1
// actually requires ("Gmail seeds via raw RFC 822"), so this file keeps sending `raw` untouched
// inside a best-effort `messages` array; if the live gmail twin wants a different top-level key than
// `messages`, that's the first thing to check in the 45-minute window, not the message shape itself.

export type ArgaSeedConfig = Record<string, unknown>;

/** One seed_config entry per twin name Arga documents (see file header) -- `linkedin` is
 * intentionally absent since Arga does not offer a LinkedIn twin. `profile` is accepted for parity
 * with other seed/deps builders (e.g. to key the owner's mailbox); nothing here reads it today
 * beyond the seed's own `owner`. */
export function toArgaSeedConfig(seed: TwinSeed, profile?: FounderProfile): Record<string, ArgaSeedConfig> {
  void profile;

  const githubUsers = Object.fromEntries(
    Object.entries(seed.github).map(([login, data]) => [
      login,
      {
        repos: data.repos.map((r) => ({ ...r })),
        reviews: data.reviews.map((r) => ({ ...r })),
      },
    ]),
  );

  return {
    // Best-effort: {messages:[{raw, labels}]} so a stock Gmail-API-shaped twin can parse headers
    // and body from the RFC 822 blob rather than trusting a pre-split shape. `raw` is the one
    // field PRD 7.1 requires to survive.
    gmail: {
      owner: seed.owner,
      messages: seed.gmail.map((m) => ({
        id: m.id,
        threadId: m.threadId,
        raw: m.raw,
        labels: m.labels,
      })),
    },
    google_calendar: {
      owner: seed.owner,
      events: seed.calendar.map((e) => ({ ...e })),
    },
    // Exhibit only ever writes to these three during a scenario; they seed empty so every filed
    // file, doc and sheet in a graded attempt is something the agent actually created.
    google_drive: { owner: seed.owner, files: [] },
    google_docs: { owner: seed.owner, documents: [] },
    google_sheets: { owner: seed.owner, spreadsheets: [] },
    github: { users: githubUsers },
    // linkedin intentionally omitted -- not a documented Arga twin (file header).
  };
}
