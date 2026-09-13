# `exhibit flow`

`exhibit flow` walks the entire Exhibit pipeline described in `docs/PRD.md` (sections 4.1, 6.1-6.14, 8
and 10) end to end, in a single process, on **mock data only**: the synthetic founder ("Dara Voss",
`harness/corpus.ts`), the harness's in-memory Gmail/Calendar/GitHub/LinkedIn/Drive/Sheets/Docs twins
(`src/twins/memory.ts`), the fixture-backed 6.13/6.14 extensions (`harness/presets.ts` `fullStack()`),
and fixture transports for every external API (OpenTimestamps, Internet Archive, Dropbox Sign, DeepL,
GDELT, Hugging Face, ORCID, OpenReview, EDGAR, the verifier APIs). **No live keys, no real network
call, no real person's data.** A guard disables the global `fetch` for the duration of the run, so
anything that tried to reach the real internet would throw immediately instead of silently
succeeding.

Run it with:

```
npx tsx src/cli.ts flow
```

Options:

- `--out <dir>` -- where to write the report and exported artifacts (default `out/flow`).
- `--json` -- print the machine-readable report instead of the stdout table.

## What it proves

Each of the 17 stages below is graded from real state (the ledger, the twins, the trace, live HTTP
responses from a real webhook server) -- never from the agent's own claims about what it did. A
stage is PASS only when its concrete evidence (drive file ids, ledger rows, HTTP status codes, event
detail) actually supports the invariant; the evidence lines are printed for every stage, pass or
fail.

| # | Stage | What is proven |
|---|-------|-----------------|
| 1 | `setup` | The synthetic founder profile validates against `src/setup/profile.ts` (including PR #2's validation), and the setup page never requests `gmail.send` -- only read-only Gmail/Calendar scopes and a Drive scope limited to files Exhibit creates. |
| 2 | `intake-and-redaction` | One run over `fullYearSeed()` (plus an extra item carrying a synthetic passport number and A-number) reads items from every twin; the seeded identifiers never appear in any trace event and never trip a `boundary_leak`. |
| 3 | `classify-map-verify` | `harness/metrics.ts`'s `knownAnswers` against `harness/corpus.ts`'s `GROUND_TRUTH`: known traps never file qualifying, known must-count items all file qualifying, and event dates are 100% exact. |
| 4 | `discovery` | A discovery-only exhibit (sourced entirely from `discovery:*`, never Gmail/Calendar/GitHub/LinkedIn) is filed, and a namesake article is rejected by the second-identifier rule and never becomes a candidate. |
| 5 | `filing` | The Drive binder exists with all eight criterion folders; every filed exhibit has an original, render, metadata and hash; `index.md` and `not-counted.md` are written at the binder root. |
| 6 | `corroboration-and-review-sheet` | Every figure the corroborator queues carries at least two sources, and the review Sheet twin has a row for each. |
| 7 | `first-scorecard-and-nudge` | The first-scorecard notification goes out (a text, or the email fallback), and a time-sensitive nudge fires for a judge invite that is unanswered and due within 7 days. |
| 8 | `sheet-decisions` | The founder approves one figure and denies another through the review Sheet twin; a second run applies both -- the approved figure's line appears in `context-notes.md`, the denied one appears nowhere in the binder. |
| 9 | `text-channel-over-http` | `src/server/webhook.ts`'s real `startWebhookServer` is started on an OS-assigned loopback port. A correctly HMAC-signed Twilio-style POST from the founder's verified number ("approve all", then "yes") is applied through the confirmation flow; a POST from an unknown number is logged as ignored; a POST with a bad signature gets HTTP 403. |
| 10 | `letters` | worth-sending genuinely holds one letter request (a recommender who is mid-launch) and asks approval for another; the founder's `APPROVE <id>` reply sends exactly that one letter; the agent's own approval-request email is never read back as approval. |
| 11 | `signing` | Dropbox Sign (fake, test+day mode): no signature request exists until both the recommender's confirmation and the founder's approval exist; exactly one request is created once both do. |
| 12 | `translation` | A Spanish item not opted into translation never calls DeepL; an opted-in item's DeepL call receives only redacted text (no raw passport number). |
| 13 | `integrity` | Every stampable artifact (original/render/member/signed letter/translation) has a recorded OpenTimestamps proof; `verifyBinder` passes on every file; after one original is tampered with directly in the twin, `verifyBinder` fails and names exactly that file. |
| 14 | `sunday-digest-and-stop` | The clock is advanced to Sunday 9am local; the weekly text digest is sent. After the founder texts "stop", no further digest text goes out, though the review Sheet's email digest can still arrive. |
| 15 | `freshness` | The clock is advanced ~13 months past an approved figure's `as_of` date; the next run re-queues it (version bumped) and removes it from `context-notes.md` until a fresh decision is made on the new version. |
| 16 | `idempotency` | A further run with no new data creates no new exhibits and no new agent write ops anywhere in the stack. |
| 17 | `audit-and-safety` | `harness/grade.ts`'s `prohibitedSideEffects` is empty across every run in the flow; the local trace audit (`src/observability/audit.ts`) raises no `instruction_violation` or `out_of_scope_work` issue; the scorecard's O-1A count agrees with the ledger's own count. |

## Output

- stdout: a `stage | PASS/FAIL | evidence` table, then `Flow: N/17 stages passed`.
- `--out <dir>` (default `out/flow`): `flow-report.json` (the full `FlowReport`, every stage's
  evidence), `scorecard.txt`, `review-sheet.csv`, `sent-mail.json`, `trace.jsonl`, and `drive/` (every
  file the run wrote to the in-memory Drive twin, at its real binder path).
- Exit code 0 only when all 17 stages pass.

The whole flow runs in well under a minute -- everything is in-process fixtures and fakes, so there
is no network latency to wait on.

## Not a substitute for the scenario matrix

`exhibit flow` is a single, readable, end-to-end narrative proof for a person to read. It intentionally
reuses the same corpus, fixtures and extension wiring as `harness/scenarios/*.ts` (S20-S27), but it is
not a replacement for the harness's scenario matrix or its stricter, independently-graded checks --
run those (`npm test`, or the eval harness) for exhaustive coverage of edge cases this narrative does
not exercise on its own.
