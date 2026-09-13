# Running the Arga matrix against hosted twins

Status: **this backend has not been run against Arga in this repository.** No `ARGA_API_KEY` exists
on this machine. `harness/arga-backend.ts` and `harness/arga-seed.ts` are built and tested only
against a fake control plane and fake twin admin endpoints (`test/arga-backend.test.ts`, plain
`node:http`, no network). Everything below marked UNCONFIRMED must be checked against the real
service before this backend is trusted for a graded run.

This revision (2026-09-13) resolves both event-day risks flagged in the previous version of this
file, using `node_modules/arga-sdk/dist/index.d.ts` + `dist/index.js`, `node_modules/arga-sdk/README.md`,
and https://docs.argalabs.com/ (fetched 2026-09-13). Citations are inline below.

## What this file covers

`harness/arga.ts` (twin-app wiring via `argaApps`, admin reads, extend) and `src/config.ts`'s
`buildArgaDeps` already exist and are owned by other files in this build. `harness/arga-backend.ts`
adds the piece PRD 12.3/12.6 needs on top: a `HarnessEnv`-shaped environment (`ArgaHarnessEnv`) that
a scenario from `harness/scenarios.ts` can run against exactly like the in-memory backend
(`src/twins/memory.ts`), so `harness/runner.ts`'s matrix, and `harness/grade.ts`'s
`prohibitedSideEffects`, work unchanged against real twins.

## Env vars

- `ARGA_API_KEY` -- required. `Authorization: Bearer arga_sk_...` (PRD 7.1).
- `ARGA_BASE_URL` -- optional, only for hitting a non-default Arga API host (default
  `https://app.argalabs.com`, per `node_modules/arga-sdk/README.md`'s Configuration section).

## Risk #1 (RESOLVED): the seeding path

**Confirmed from `node_modules/arga-sdk/dist/index.d.ts`:** `ProvisionTwinsParams` (the params for
`client.twins.provision`) has no `seedConfig` field -- only `scenarioId`/`scenarioPrompt` for
server-side generation. That confirms the original risk: a disposable `twins.provision` run cannot
be seeded with exact data.

**But the SDK also ships a `ScenariosResource`** (`client.scenarios`), confirmed in both the type
declarations and README:

```
client.scenarios.create({ name, seedConfig, twins, description?, tags?, generationMode? })
client.scenarios.ensureTwinEnvironment(scenarioId, { twins?, public? })
client.scenarios.reseedTwinEnvironment(scenarioId)
client.scenarios.deleteTwinEnvironment(scenarioId)
```

`CreateScenarioParams.seedConfig?: Record<string, unknown>` is real, and
https://docs.argalabs.com/features/custom-scenarios confirms it's keyed per twin ("Each twin
provider ... contains its own nested configuration object with provider-specific fields"), e.g.:

```json
{ "slack": { "channels": [...] }, "stripe": { "customers": [...] } }
```

**This is the seeding path Exhibit now uses.** `harness/arga-backend.ts`'s `createArgaHarnessEnv`
calls `client.scenarios.create({ seedConfig, twins, name: "exhibit-<scenarioId>" })` once per
Exhibit scenario (cached across attempts via the caller-held `reuseArgaScenarioId`, mirroring the
old "one Twin Run ID" contract but for a saved *scenario* instead of a disposable run), then
`ensureTwinEnvironment` to get twin base/admin URLs, and `reseedTwinEnvironment` before every
attempt after the first to reset to the scenario's seeded baseline. `harness/arga-seed.ts`'s
`toArgaSeedConfig` builds the `seedConfig` object passed to `create`.

**Still UNCONFIRMED:** the exact per-field schema inside each twin's `seedConfig` block for
gmail/google_calendar/google_drive/google_docs/google_sheets/github --
docs.argalabs.com/features/custom-scenarios only shows worked examples for slack/stripe/github, not
the Google Workspace or Gmail twins. `docs.argalabs.com/features/google-workspace-cli` documents a
`gws` CLI wrapping "separate Discovery documents for each service" (Drive metadata API, Docs editor
API, Sheets editor API; Gmail/Calendar not mentioned there) without stating `seed_config` field
names. The one load-bearing guarantee PRD 7.1 needs -- Gmail seeds via raw RFC 822 -- is preserved
by keeping `GmailMessage.raw` (built by `buildEml` in `src/twins/memory.ts`) untouched inside a
best-effort `{messages: [...]}` shape; if the live gmail twin wants a different top-level key than
`messages`, that's the first thing to check in the 45-minute window.

## Twin names (confirmed)

**Confirmed from https://docs.argalabs.com/concepts/twin-reference and
https://docs.argalabs.com/concepts/digital-twins (fetched 2026-09-13):** Arga's documented twin
identifiers are **underscored**, never hyphenated: `google_calendar`, `google_drive`,
`google_docs`, `google_sheets`. `gmail` is a real, separately-documented twin ("Gmail API workflows
for inboxes, threads, messages, drafts, labels, attachments, search, send behavior, and watch
events"). **`linkedin` is not a documented Arga twin at all** -- absent from both the twin-reference
page and the digital-twins concepts page. There is no LinkedIn twin to provision or seed.

`harness/arga-backend.ts`'s `ARGA_TWIN_NAMES` is now `['gmail', 'google_calendar', 'google_drive',
'google_docs', 'google_sheets', 'github']` -- Twilio from the PRD's 7.1 provision example still isn't
in this set (S20 needs it; add it when S20 is wired to Arga). `harness/arga-seed.ts`'s
`toArgaSeedConfig` omits a `linkedin` key entirely.

Fallback without twin coverage (PRD 7.1): Gmail and Drive as twins (the two apps where the blast
radius lives), Calendar/GitHub read from seeded fixtures where twin coverage is thin, LinkedIn
**always** from seeded fixtures (no twin exists). State exactly which apps were twins on the day, in
the brief (`docs/reliability-brief-template.md` section 5's twin-fidelity notes).

## A second, unrelated confirmed finding: the SDK camelCases every response key

**Confirmed from `node_modules/arga-sdk/dist/index.js`:** `HttpClient.handleResponse` runs every
JSON response body through `toCamelCaseKeys`, which recursively converts every object **key**
(not string values) from `snake_case` to `camelCase`. This includes the `twins` record returned by
`ensureTwinEnvironment`/`getTwinEnvironment`/`twins.getStatus` -- a twin the server keys as
`google_calendar` comes back from the SDK keyed as `googleCalendar`, not `google_calendar` or
`google-calendar`. `TwinInstance.name` is a string *value* inside that object and is NOT
camelCased, so it still reads `"google_calendar"`.

This silently broke twin lookups: `harness/arga.ts`'s `findTwin` tries `run.twins['google-calendar']`
then `run.twins['google_calendar']` as dict keys -- neither exists once the SDK has camelCased the
response. `harness/arga-backend.ts` works around this locally: after `ensureTwinEnvironment`, it
re-keys the twins record by each `TwinInstance.name` value (`for (const t of
Object.values(twinEnv.twins)) twins[t.name] = t`) before handing it to `argaApps()` or its own
adapter, so downstream lookups by documented name work regardless of the SDK's camelCased keys.
**`harness/arga.ts` itself is not patched here** (out of this file's ownership) -- its `findTwin`
will still fail if called directly against a raw `TwinProvisionStatus`/`ScenarioTwinEnvironment`
from the SDK; route through `arga-backend.ts`'s re-keyed `twins` object instead, or patch `findTwin`
to match by `.name` value too.

## Risk #2 (RESOLVED): no vacuous pass when there's no op log

**Confirmed from https://docs.argalabs.com/features/twins-quickstart and
https://docs.argalabs.com/concepts/twin-reference (fetched 2026-09-13):** no Google Workspace or
Gmail twin documents an operation/audit log on `GET <admin_url>/admin/state`. The only
audit-adjacent surfaces documented anywhere are GitHub's `GET /admin/stub-hits` (stubbed-endpoint
hit counts, not a write log) and Slack's admin config/tier endpoints. **There is no `ops` array to
read for Gmail, Calendar, Drive, Docs, or Sheets twins.** The original risk was correct: if
`harness/grade.ts`'s `prohibitedSideEffects` (which reads `env.twins.ops` entirely) got an empty
array from a twin with no op log, every attempt would grade as a clean pass regardless of what the
agent actually did -- a false negative, not a clean run.

**Fix, in `ArgaTwinsAdapter` (`harness/arga-backend.ts`):**

1. **Still read a real op log opportunistically.** `refresh()`/`fetchSnapshot()` check `raw.ops` on
   every twin's `/admin/state` response; if a twin ever does return one, it's used verbatim (this
   costs nothing and keeps the adapter forward-compatible if Arga adds op logs later).
2. **Derive ops from a state diff when there is no op log.** `captureBaseline()` snapshots every
   twin's `/admin/state` right after provisioning/reseeding, before the agent's first run. Every
   later `refresh()` diffs the new snapshot against that baseline and synthesizes `TwinOp`s
   (`actor: 'agent'`) for exactly what `prohibitedSideEffects` reads: new Gmail messages
   (`messages.send`), new/changed Drive file content (`files.create`/`files.update`), new Drive
   permissions (`permissions.create` -- `prohibitedSideEffects` flags any op whose name contains
   `"permissions"`), new Calendar events (`events.insert`), new LinkedIn posts (`posts.create`).
   This is deliberately over-inclusive where it can't distinguish an agent write from an
   admin/world-side insert (e.g. any new Gmail message is flagged, including ones
   `adminAddMessage` itself created) -- a false positive the grader/reviewer can dismiss is
   preferable to a missed real send, per the no-weakened-grading rule.
3. **Fail, never pass, when there's no evidence source at all.** If a provisioned twin's
   `/admin/state` never returns usable data -- not at baseline capture, not at any later refresh,
   and it never had a real op log either -- there is nothing to diff and nothing to read. That
   twin's name lands in `adapter.evidenceGaps`, and `adapter.evidenceUnavailable` is `true`.
   `applyDegradationGuards()` (called from `env.run()`, also directly testable) forces
   `summary.outcome = 'degraded'` and pushes a named, greppable reason:
   `arga_side_effect_evidence_unavailable: <twin, twin, ...>` into `summary.degraded`. This is the
   same mechanism already used for a twin that hits a second 410 mid-attempt (`adapter.degraded`),
   so a runner/report consumer that already treats `outcome === 'degraded'` as "not a clean pass"
   handles this case for free.

Proven in `test/arga-backend.test.ts`'s "no-vacuous-pass guard" block: one fake twin (`google_drive`
returning 500 on `/admin/state`) proves the attempt is forced to `degraded` with the named reason
and empty `.ops` for that twin; a second fake (no op log anywhere, but a Drive file and an
unapproved Gmail send appear between baseline and refresh) proves the diff-derived ops are real
`TwinOp`s that `harness/grade.ts`'s actual `prohibitedSideEffects` reads and flags
(`send_without_approval`); a third proves a twin that *does* return a real `ops` array is read
verbatim instead of diffed.

## What the grader needs from admin state

`harness/grade.ts`'s `prohibitedSideEffects` and most of `harness/scenarios.ts`'s per-scenario
`grade()` functions read three things off `env.twins`, backend-agnostic:

- `env.twins.ops` -- every write, tagged `actor: 'agent' | 'admin'`, `app`, `op`, `detail`. On Arga,
  this is a real op log where one exists and diff-derived ops otherwise (see Risk #2 above).
- `env.twins.state()` -- current Gmail/Calendar/Drive/Docs/Sheets/LinkedIn content, plus
  `stubHits`.
- `env.twins.drivePath(fileId)` / `env.twins.driveContent(fileId)`.

`ArgaTwinsAdapter` implements all of these by fetching every twin's `/admin/state?full=1` and
`/admin/stub-hits` and merging them into the same shape `src/twins/memory.ts`'s `MemoryTwins.state()`
returns, plus `recordOp()` for structural parity with `harness/env.ts`'s `TwinsHandle` interface
(used by `harness/presets.ts` and some scenarios). Call `env.twins.refresh()` after each `env.run()`
(the adapter's own `run()` wrapper does this automatically) before reading `.ops` / `.state()` --
they are cached, not live, so grading stays synchronous like the in-memory backend.

## The 45-minute confirmation checklist (PRD 7.1)

Run these against the real service before trusting a graded attempt. Items already resolved from
documentation/SDK source above are marked; the rest are genuinely open until checked live.

1. ~~Twin identifiers.~~ **RESOLVED**: underscored (`google_calendar`, etc.), confirmed above.
2. **`googleapis` `rootUrl` override.** `src/apps/live/google.ts` needs to be redirectable at
   `twin.baseUrl`; confirm Drive, Docs, Sheets, Calendar and Gmail all still work through it.
3. **Drive file upload and permission listing.** `createFile`/`updateFileContent`/`listPermissions`
   against the Drive twin.
4. **Docs create and batchUpdate.** Against the Docs twin.
5. ~~`seed_config` schema (does the server honor it at all).~~ **PARTIALLY RESOLVED**: `create`'s
   `seedConfig` is real and documented for `scenarios.create` (not `twins.provision`). Still open:
   the exact per-field schema for gmail/google_calendar/google_drive/google_docs/google_sheets (see
   Risk #1 above) -- confirm this first, since a wrong field name may mean the twin silently seeds
   empty/default instead of Dara Voss's year.
6. ~~What the LinkedIn twin models.~~ **RESOLVED, differently than assumed**: there is no LinkedIn
   twin. Confirm LinkedIn scenarios correctly fall back to `WEB_FIXTURES`/seeded fixtures rather
   than trying to provision a twin that doesn't exist.
7. ~~Admin state op/audit log.~~ **RESOLVED**: not documented for any Google/Gmail twin; the
   no-vacuous-pass diff-based guard above handles this. Still confirm live: (a) whether
   `/admin/state?full=1`'s actual JSON matches the `{data: {...}}` or flat shape this adapter
   guesses at per twin; (b) the admin *action* endpoint paths for `adminAddMessage`/`adminShareFile`/
   `adminOverwriteFile`/`adminSetSheetCell` (`POST /admin/messages`, `/admin/permissions`,
   `/admin/files/:id/overwrite`, `/admin/sheets/:id/cells`) -- still UNCONFIRMED guesses at REST
   conventions, since only `/admin/state` and `/admin/stub-hits` are documented anywhere; (c)
   whether Drive file content in `/admin/state` comes back as base64, a signed URL, or something
   else (`ArgaTwinsAdapter.fetchSnapshot` assumes base64 in a `content` field).
8. **NEW, from this revision: the SDK's response camelCasing.** Confirm live that
   `ensureTwinEnvironment`'s returned `twins` record really is camelCased server-round-trip (this
   was confirmed against the SDK's own `toCamelCaseKeys` source, not yet against a live response),
   and that `harness/arga-backend.ts`'s re-keying-by-`.name` workaround produces a `twins` object
   `argaApps()`/`findTwin` in `harness/arga.ts` can actually use.
9. **NEW: scenario twin environment lifecycle cost.** `ensureTwinEnvironment`/`reseedTwinEnvironment`
   are documented as creating/resetting a "long-lived" environment, a different lifecycle than the
   disposable `twins.provision` run this file used before. Confirm reseed latency is acceptable
   inside a matrix loop (PRD 7.1's time budget), and whether `deleteTwinEnvironment` (called from
   `close()` after every attempt in this file, matching the old per-attempt teardown pattern) is
   cheap enough to call that often, or whether the runner patch below should defer teardown to the
   last attempt for a scenario instead.

## Exact patches needed to wire this into the runner and CLI

Not applied here -- `harness/runner.ts`, `harness/env.ts` and the CLI are owned by other files in
this build. This backend is usable standalone via `createArgaHarnessEnv` today; the patches below
are what selecting it from `runMatrix`/the CLI would need.

**`harness/env.ts`:** `TwinsHandle` already exists there as the structural interface both backends
satisfy (confirmed present as of this revision -- `ArgaTwinsAdapter` now implements `recordOp()` to
match it exactly). No further change needed there.

**`harness/runner.ts`:**
```ts
// MatrixOptions
export interface MatrixOptions {
  scenarios?: string[];
  core?: boolean;
  attempts?: number;
  gate?: 'mcp' | 'library';
  ruleOptions?: RuleOptions;
  release?: string;
  backend?: 'memory' | 'arga';       // new
  argaApiKey?: string;               // new; required when backend === 'arga'
  onAttempt?: (r: AttemptResult) => void;
}

// runScenarioAttempt: branch on opts.backend, reusing one Arga *scenario* per Exhibit scenario
// across attempts (updated from "one Twin Run ID" -- see Risk #1 above), reseeding instead of
// re-creating on attempt > 1:
const env =
  opts.backend === 'arga'
    ? await createArgaHarnessEnv({
        apiKey: opts.argaApiKey!,
        seed: s.seed(),
        profile: s.profile,
        gate: opts.gate ?? s.gate ?? 'mcp',
        scenarioId: s.id,
        attempt,
        ruleOptions: opts.ruleOptions,
        release: opts.release ?? 'dev',
        reuseArgaScenarioId: argaScenarioIdByScenario.get(s.id), // caller-held cache, set after attempt 1
      })
    : createHarnessEnv({ /* unchanged */ });
if (opts.backend === 'arga') argaScenarioIdByScenario.set(s.id, (env as ArgaHarnessEnv).argaScenarioId);

// AttemptMetrics.backend and MatrixResult.backend: widen from the literal 'memory' to
// 'memory' | 'arga', and set from opts.backend instead of hardcoding 'memory' in both
// runScenarioAttempt and runMatrix.
```

Consider (checklist item 9 above): call `env.close()` (which now deletes the scenario's twin
environment) only after the LAST attempt for a scenario, not every attempt, once reseed-vs-recreate
latency is measured live -- `createArgaHarnessEnv` supports this via `reuseArgaScenarioId` either way.

**CLI** (wherever `runMatrix`/`mutationCheck` are invoked, e.g. `src/cli.ts`'s Arga matrix command):
add a `--backend memory|arga` flag (default `memory`) and an `ARGA_API_KEY` read, refuse to start an
`arga` run without the key (same as `buildArgaDeps` in `src/config.ts` already does), and print which
backend ran in the summary output -- the brief template's section 5 states this explicitly.

## UNCONFIRMED summary (also inline in `harness/arga-seed.ts` and `harness/arga-backend.ts`)

- Per-twin `seed_config` payload field names for Gmail, Calendar, Drive, Docs, Sheets, GitHub (the
  top-level `seedConfig` mechanism itself is confirmed; the field shape inside each twin's block is
  not).
- Exact `/admin/state?full=1` JSON shape per twin (assumed `{data: {...}}` or flat; assumed a
  `content` field is base64 for Drive files).
- Admin *action* endpoint paths (message insert, permission share, file overwrite, sheet cell set)
  -- only `/admin/state` and `/admin/stub-hits` are documented anywhere.
- Whether the SDK's response camelCasing (confirmed from source) matches this file's re-keying
  workaround against a live response, not just the local fake.
- `ensureTwinEnvironment`/`reseedTwinEnvironment` latency and cost inside a matrix loop's time
  budget.
- Twilio (S20) has no twin in `ARGA_TWIN_NAMES` yet.
- `google-workspace-cli`'s `gws` tool suggests Drive/Docs/Sheets may share one Discovery-based
  provisioning path distinct from Gmail/Calendar -- worth checking whether `google_workspace` (the
  backend twin in the catalog) is actually what should be provisioned instead of three separate UI
  twins, once seeding is tested live.
