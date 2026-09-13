# Running the Arga matrix against hosted twins

Status (2026-09-14): **the Arga backend runs against live Arga twins.** Every fact below was
checked against the real service with a Free-plan key, not read from docs. All 21 core scenarios
pass on hosted twins: 301 of 301 checks, zero prohibited side effects (one attempt each, offline
stand-in model, `eval --backend arga --core --attempts 1`).

```bash
# .env (gitignored): ARGA_API_KEY=arga_sk_...   (ARGA_BASE_URL is optional)
node --env-file=.env node_modules/.bin/tsx src/cli.ts eval --backend arga --scenario S2 --attempts 1
node --env-file=.env node_modules/.bin/tsx src/cli.ts eval --backend arga --core --attempts 3
```

## Which apps are twins

| App | On Arga | Why |
|---|---|---|
| Gmail | Twin (`gmail`) | |
| Google Calendar | Twin (`google_calendar`) | |
| Google Drive, Docs, Sheets | Twins (`google_drive`, `google_docs`, `google_sheets`) | One shared store behind three base URLs |
| GitHub | Seeded fixture | Arga's GitHub seed models repos, files, branches and issues, not third-party stargazers or the founder's reviews on other people's PRs (the #5 and #4 signals) |
| LinkedIn | Seeded fixture | Arga lists a LinkedIn twin; Exhibit's LinkedIn client targets a guessed API and has not been checked against it |

Five Google twins in one scenario environment work on the Free plan. The Free plan's
one-twin limit applies to short-lived Twin Runs, not to a saved scenario's environment.

## How an attempt runs (`harness/arga-backend.ts`)

1. Find the saved scenario `exhibit-twins` (create it once with the skeleton seed:
   an empty mailbox, one `Primary` calendar, an empty Drive).
2. `ensureTwinEnvironment`, wait for `ready`. If the mailbox is not empty (a leftover
   environment), `reseedTwinEnvironment`; if it is still not empty, refuse to run.
3. Insert the scenario's messages (oldest first, threads kept) and events through the twins'
   own Gmail and Calendar APIs. `SeedIdMap` translates twin-assigned ids back to the seed's
   ids, so the agent and the graders see `m-accel`, as in memory mode.
4. Read a baseline through the twins' APIs (an unreadable baseline aborts the attempt), run the
   agent, read again, and derive side effects from the diff: sends, new or changed Drive files,
   new shares, calendar inserts. A file the agent created is compared with the bytes it uploaded,
   so an edit in the same run still shows. Docs and Sheets writes (native files the Drive diff
   cannot content-compare) are recorded from the agent's own client calls, as memory mode records
   every op. World actions a scenario performs (a new email, a share, an overwrite, a sheet edit)
   go through the same APIs, one at a time in call order, and are recorded as admin ops, never
   agent ops. Every agent run and the final grade wait for queued world actions to land.
5. `deleteTwinEnvironment` on close.

A twin whose state cannot be read after a run lands in `evidenceGaps`, and the run is forced to
`degraded` with `arga_side_effect_evidence_unavailable: <twins>`; on the final read before grading
the attempt fails with that error. It never grades as a clean pass.

## Verified facts about the service

- **API host is `https://api.argalabs.com`.** The SDK's default, `app.argalabs.com`, is the web
  app and returns HTML to every API call. `ARGA_API_BASE_URL` in `harness/arga.ts` is now the
  default.
- **Twin names are underscored:** `gmail`, `google_calendar`, `google_drive`, `google_docs`,
  `google_sheets` (from `GET /twins`).
- **Each twin has its own token env var:** `GMAIL_ACCESS_TOKEN`, `GOOGLE_CALENDAR_ACCESS_TOKEN`,
  and `GOOGLE_ACCESS_TOKEN` for Drive, Docs and Sheets. The environment's `proxy_token` is
  rejected by the twins' Google APIs (401). `tokenFor` picks any `*ACCESS_TOKEN` var.
- **The SDK camelCases every response key**, including the twins map (`googleCalendar`). The
  backend re-keys twins by their `name` value.
- **Gmail seed schema** (read back from a scenario Arga generated itself):
  `{messages: [{subject, body, from, to[], labels, message_id, thread_id}]}`. No date field and
  no raw field: seeded messages all get the twin's clock date, and a `raw` entry crashes seeding
  with a 500. `messages.insert` with `raw` keeps the original bytes, the `Date:` header and the
  thread (`threadId` on insert is honored). Gmail's `internalDate` is the twin clock (2026-01-01),
  which is why Exhibit reads the `Date:` header.
- **Calendar:** with no seeded calendar, `calendars/primary/events` is 404. A seeded calendar
  becomes `primary`.
- **Admin state** (`GET <admin_url>/admin/state?full=1`) has a different layout per twin
  (Gmail under `mailboxes.<owner>.messages`, Calendar as Google-shaped `events`), no op log, and
  no Drive file content. The backend reads through the public APIs instead.
- **`/admin/stub-hits` is 404** on the Gmail and Drive twins. Stub hits are not observable for
  the Google twins; the fixture-backed GitHub and LinkedIn apps still report theirs.

## Twin fidelity findings (for the brief)

1. **Drive twin drops upload content by media type.** A multipart upload whose media part is
   `message/rfc822` or `application/json` is stored as 0 bytes (`size: 0`, empty-file md5);
   `text/*`, `application/pdf` and `application/octet-stream` keep their bytes. Exhibit now
   declares the type in the metadata and sends the bytes as `application/octet-stream`, which
   the real Drive API also accepts (`src/apps/live/google.ts`).
2. **Gmail seed has no date.** Covered above; worked around by inserting through the API.
3. **Drive twin renames on a content update.** A content-only update resets the file to
   `Untitled` and `application/octet-stream` (real Drive keeps both). `updateFileContent` now
   sends the file's own name and type with the bytes.
4. **Drive twin injects its control panel into HTML downloads.** A `text/html` file is served
   with Arga's own `<style>`, `<aside>` and `<script>` (tagged `data-twin-control-plane`) inserted
   before `</body>`: 90 bytes stored, 6,776 served. Every source-snapshot hash check failed on it,
   so every figure approval was rejected. The harness (not Exhibit) strips exactly that tagged
   block on read, restoring the stored bytes (`stripTwinControlPlane`).
5. **googleapis ignores a client-level `rootUrl` for media uploads.** Not an Arga bug, found by
   running against Arga: `googleapis-common` rewrites the request URL onto `rootUrl` but not the
   media upload URL, so every `files.create`/`files.update` with a body went to
   `www.googleapis.com` while metadata calls went to the twin. Fixed by passing `rootUrl` per
   call (`mediaOptions` in `src/apps/live/google.ts`). Without it, a twin run with a real token
   would write originals to a real Drive.

## Not covered on Arga yet

- `s.twinOptions` reaches only the fixture-backed GitHub and LinkedIn apps, so a forced 410 on a
  Google app (memory mode's `expire`) does not happen on Arga.
- A share on a folder is excluded from the agent diff only for that folder; whether the Drive twin
  shows inherited permissions on child files (real Drive does) is unverified, which matters for
  S14.
- Every attempt uses the one saved `exhibit-twins` environment, so two `eval --backend arga`
  runs at once would reseed each other. Run one at a time.
- Twilio (S20) has no twin in the provisioned set.
