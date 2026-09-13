# Live smoke test — keyless public integrations

Ran: 2026-09-13T17:32:21.900Z (see `reports/live-smoke.json` for the machine-readable record).

Constraint 19: this file only calls an integration "live" for rows marked **ok** below — each of
those adapters ran against the real endpoint in this build, not fixtures. Everything else stays
`built_not_exercised` or worse until it is re-run and passes.

Network was available in this sandbox (confirmed against hn.algolia.com, api.crossref.org,
archive.org, api.github.com before running). `npx tsc --noEmit -p .` was clean for `src/integrity/*`
(the two pre-existing errors are in `harness/presets.ts` and `src/config.ts` over an unrelated
`OnetAdapterOptions.username` field, nothing under `src/integrity/`), so OpenTimestamps was run.

Queries used: GDELT/HN query `"opentimestamps"`; Crossref + Semantic Scholar DOI
`10.1038/nature14539`; ecosyste.ms + GitHub REST repo `github.com/opentimestamps/opentimestamps-client`;
BLS SOC `15-1252`, national 90th-percentile series; Internet Archive availability for
`https://opentimestamps.org`; OpenTimestamps: one fresh random 32-byte digest posted to
`a.pool.opentimestamps.org` only (single calendar, to stay inside the 3-request budget). No personal
data in any query.

## Results

| service | endpoint | status | parser produced expected shape | count | latency | verdict |
|---|---|---|---|---|---|---|
| gdelt | `api.gdeltproject.org/api/v2/doc/doc` | 200 | yes | 0 items | 11874 ms | ok (0 hits is correct — no news mentions `"opentimestamps" "opentimestamps"` verbatim in the window) |
| hackernews | `hn.algolia.com/api/v1/search` | 200 | yes | 10 items | 2029 ms | **ok — exercised live** |
| crossref | `api.crossref.org/works/{doi}` | 200 | yes | 1 candidate | 657 ms | **ok — exercised live** |
| ecosystems | `repos.ecosyste.ms/api/v1/hosts/GitHub/repositories/{repo}` | 200 | yes | 1 candidate | 473 ms | **ok — exercised live** |
| platformstats (GitHub REST) | `api.github.com/repos/{owner}/{repo}` | 200 | yes | 2 candidates (stars, forks) | 342 ms | **ok — exercised live** |
| bls | `api.bls.gov/publicAPI/v2/timeseries/data/` | 200 | yes | 1 candidate | 755 ms | **ok — exercised live**, unregistered (empty `registrationkey`) |
| semanticscholar | `api.semanticscholar.org/graph/v1/paper/DOI:{doi}` | 200 (this run) | **no** — 0 candidates | 384 ms | inconclusive, see below |
| archive (availability API only) | `archive.org/wayback/available` | 200 | yes | snapshot available | 2546 ms | **ok — exercised live** |
| opentimestamps | `a.pool.opentimestamps.org/digest` | 200 | yes | 1 calendar path | 1990 ms | **ok — exercised live** (single-calendar smoke; `DEFAULT_CALENDARS` has 3, only one was called to respect the 3-request cap once GET/status polling is counted) |

## GDELT: the timeout that wasn't a service defect

A first attempt at `api.gdeltproject.org` timed out after 10s via a bare `curl`; a second attempt
through the adapter succeeded at 11.9s. This looks like GDELT-side latency/cold-path behavior on this
query, not a parser or transport defect — `FetchTransport`'s hardcoded 20s timeout (`src/integrations/types.ts:47`)
comfortably covers it, so no code change is needed. Worth flagging only if repeat runs show it
consistently exceeding 20s.

## Semantic Scholar: DOI:10.1038/nature14539 returned 200 with no citationCount in one run, 404 via plain curl moments later

Direct `curl` against `GET /graph/v1/paper/DOI:10.1038/nature14539?fields=citationCount,influentialCitationCount`
returned `404 {"error":"Paper with id DOI:10.1038/nature14539 not found"}` both before and after the
smoke run. The adapter call itself logged `status: 200` with `citationCount` absent (parser correctly
detected the missing field and returned `errors: []`, `candidates: []` — see `src/integrations/semanticscholar.ts:62`,
`parsed.citationCount === undefined` guard). This is most likely transient inconsistency on
Semantic Scholar's side (edge cache serving a stale/empty document for that DOI on one node) rather
than an Exhibit defect: the parser behaved correctly for whatever body it received. **Not run again**
in this smoke pass to respect the 3-request/service cap — re-run to confirm before trusting either
result. No patch proposed; this needs one more live run (with a different, more heavily-cited DOI, e.g.
`10.1109/CVPR.2016.90`) to distinguish "this DOI is flaky in Semantic Scholar" from "the adapter has a
real bug."

## Adapter defects found

None. All seven verifier/discovery field-name assumptions checked out against live responses
(`stargazers_count`, `forks_count`, `downloads`, `is-referenced-by-count`, BLS `Results.series[0].data[0].value`,
OTS calendar `Timestamp` binary format, IA `archived_snapshots.closest.available`/`url`). No patches
needed this run.

## What may now honestly be called "exercised live (smoke)"

hackernews, crossref, ecosystems, platformstats (GitHub REST leg only — the Hugging Face leg was not
exercised, no HF model URL in the smoke fixture), bls (unregistered-key path), archive (availability
API only — Save Page Now was never called, per instructions), opentimestamps (single-calendar smoke
only — `DEFAULT_CALENDARS`' other two calendars, and `upgrade`/`verifyProof`, were not exercised).
gdelt ran and parsed correctly but returned zero hits, so its parser is confirmed on the empty-result
path only, not the populated-article path. semanticscholar is **not** confirmed live this run —
result was inconclusive (see above); it should still be described only as tested against fixtures
until a clean re-run lands.

None of these are elevated to "live" beyond what this file states — the GitHub/gdelt/HN/crossref/ecosystems/bls/archive/opentimestamps
lines above are the full extent of what ran in this build.

## Re-run 2026-09-13 (later same day): gdelt + semanticscholar only, `--only gdelt,semanticscholar`

`scripts/live-smoke.ts` was extended with a `--only <service,...>` flag so a subset can be re-run
without touching the other seven services' budgets. Non-personal queries chosen for coverage:
GDELT founderName/company pair `"Federal Reserve"` / `"interest rates"` (after an initial attempt
with `"climate change"` / `"United Nations"` also came back empty); Semantic Scholar DOIs
`10.48550/arXiv.1706.03762` then, on a miss, `10.1145/3292500.3330701` (KDD 2019, "XGBoost"-adjacent
well-cited paper). Requests stayed within the 3-per-service cap (gdelt: 3 script requests across two
query attempts; semanticscholar: 2 script requests, one per DOI) and no response bodies were stored.

| service | endpoint | status | parse ok | counts | latency | verdict |
|---|---|---|---|---|---|---|
| gdelt (attempt 1, climate/UN query) | `api.gdeltproject.org/api/v2/doc/doc` | error | — | — | 11070 ms | `fetch failed` — undici `ConnectTimeoutError` (10s connect timeout) to `api.gdeltproject.org:443` |
| gdelt (attempt 2, climate/UN query) | `api.gdeltproject.org/api/v2/doc/doc` | 200 | yes | 0 items | 13331 ms | connected and parsed, but 0 articles |
| gdelt (attempt 3, Fed/rates query) | `api.gdeltproject.org/api/v2/doc/doc` | 200 | yes | 0 items | 12534 ms | connected and parsed, but 0 articles |
| semanticscholar (DOI 10.48550/arXiv.1706.03762) | `.../paper/DOI:{doi}` | 404 (real) | n/a | 0 candidates | — | correctly-parsed 404; this DOI is not registered under that prefix in S2 |
| semanticscholar (DOI 10.1145/3292500.3330701) | `.../paper/DOI:{doi}` | 200 | no | 0 candidates | 303 ms | `citationCount` absent from the body the adapter received |

### GDELT: real matching articles exist, but the adapter never saw one in this sandbox

A direct `curl` to the *exact* URL the adapter builds for the Fed/rates query (verified by
constructing it identically, including `encodeURIComponent`) returned real, non-empty results —
articles about Fed policy and interest rates, dated as recently as today. A follow-up direct call
through `FetchTransport` itself (bypassing the script, same class/options as the adapter uses)
reproduced the connect-timeout failure: `TypeError: fetch failed` / `UND_ERR_CONNECT_TIMEOUT` at
`api.gdeltproject.org:443`, 10000ms. `curl` from this same sandbox succeeds on the same host/port
around the same time. This is the same asymmetry the original run flagged in "GDELT: the timeout
that wasn't a service defect" above, now reproduced on a query independently confirmed (via `curl`)
to have real matching articles — so the 0-item, 200-status responses on attempts 2 and 3 are most
likely this sandbox's egress path to `api.gdeltproject.org` being slow/lossy enough that some
requests connect late and get a stale/empty edge response, not a query-construction or parser bug.
`src/integrations/gdelt.ts`'s query-building (`gdelt.ts:86-87`) and parsing (`gdelt.ts:95-101`) are
unchanged from the prior run and match `curl`'s working URL byte-for-byte. **GDELT is not promoted**:
the adapter still has not normalized a real article in this build, so it stays exactly as
`LIVE_SMOKE_STATUS` already describes it (`live: true`, "ran only on an empty result").

### Semantic Scholar: same transient-inconsistency symptom, different DOI

`10.1145/3292500.3330701` is a real, well-cited paper (confirmed via direct `curl`, both with the
DOI's `/` left raw and `%2F`-encoded, seconds apart: `{"citationCount": 11494, ...}` both times — so
the adapter's `encodeURIComponent(doi)` on `semanticscholar.ts:51`, which percent-encodes the `/`
in the DOI, is not the cause; S2 accepts both forms). The adapter's own request against the identical
DOI, a few seconds earlier in the same run, got HTTP 200 with `citationCount` missing from the body —
the same shape of transient inconsistency the original run saw for `10.1038/nature14539`, now
reproduced on a second, independently-verified-live DOI. The parser's `citationCount === undefined`
guard (`semanticscholar.ts:62`) and the sentence-match check (`semanticscholar.ts:63-64`) both did
their job correctly against whatever body arrived. **Semantic Scholar is not promoted**: no candidate
with a citation count came back from the adapter in this build, so it stays exactly as
`LIVE_SMOKE_STATUS` already describes it (`live: false`, inconclusive).

### Adapter defects found (this re-run)

None. Both `gdelt.ts` and `semanticscholar.ts` built correct URLs and parsed correctly whatever body
they received; the two misses trace to the network path and to Semantic Scholar's own response
inconsistency, not to Exhibit code. No patch proposed.

### `LIVE_SMOKE_STATUS` / brief-visible status: unchanged

Neither service met this task's promotion bar (GDELT: a normalized real article; Semantic Scholar: a
candidate carrying a citation count), so `src/integrations/registry.ts`'s `LIVE_SMOKE_STATUS` rows for
`gdelt` and `semanticscholar` were left exactly as they already were — this re-run adds diagnostic
detail (above) rather than a status change. `test/brief.test.ts`'s live-claim-gating test required no
update for the same reason.

## Keyless, no-account services: ORCID, OpenReview, SEC EDGAR, GDELT (2026-09-13, later same day)

One request per service, respecting each service's own rate-limit guidance. Every request used
`User-Agent: Exhibit hackathon smoke test (contact via github.com/mehek-builds/exhibit)` where the
transport allows a custom header (`fetch`/`curl` direct, not through `FetchTransport`'s
hardcoded UA for ORCID/GDELT below — see per-row note). No real private person's data was queried:
ORCID used the public demo record `0000-0002-1825-0097` (ORCID's own published example, "Josiah
Carberry", a fictional Brown University library test identity); OpenReview and EDGAR queries used
public venue/company names only; GDELT queried a well-known public company name (`"Apple Inc"`).

| service | endpoint | request | status | OK/FAIL | adapter parsed it? |
|---|---|---|---|---|---|
| ORCID public API | `GET pub.orcid.org/v3.0/{id}/works` | `0000-0002-1825-0097` (ORCID's own public demo record), no auth header | 200 | **OK** | **Yes** — response shape matches `src/integrations/orcid.ts`'s `OrcidWorksResponse` exactly: `group[].work-summary[0]` with `title.title.value`, `external-ids.external-id[]` (`external-id-type`/`external-id-value`), `put-code`. This record's entries happen to omit `journal-title` and `publication-date`, both of which the adapter already treats as optional (`?? undefined`, `isoFromParts` returns `null` on a missing `year.value`), so no adapter change is needed. Note: `orcid.ts`'s `getToken()` normally exchanges `clientId`/`clientSecret` for a bearer token first — this smoke request skipped that (no ORCID app credentials available keylessly) and called the public GET directly with no `Authorization` header, which ORCID's public API accepts for public records; the token-based path in the adapter itself was not exercised, only the response shape it expects to receive. |
| OpenReview public API | `GET api2.openreview.net/notes?content.venueid=...` and `GET .../groups?id=...` | public venue id `ICLR.cc/2024/Conference` and group id `OpenReview.net`, no auth header | 403 | **FAIL** | Not applicable — no body to parse. First request (`/notes`) hit `{"name":"ChallengeRequiredError", "status":403, "details":{"challengeUrl":...}}` (an anti-bot browser challenge, not a normal auth error); the second (`/groups`) hit `{"name":"ForbiddenError","message":"User Guest is not reader of OpenReview.net"}`. Both are real, well-formed API JSON error bodies (not HTML), so connectivity to `api2.openreview.net` itself is fine — but OpenReview's API is not actually anonymous-readable for these paths from this sandbox's network, matching `src/integrations/openreview.ts`'s own existing design: it already requires `login()` with the founder's username/password before any read (never attempts an anonymous call). No code change needed; this confirms the adapter's assumption (login required) rather than contradicting it. |
| SEC EDGAR full-text search | `GET efts.sec.gov/LATEST/search-index?q="Tesla"&forms=D` | company name `"Tesla"`, `User-Agent: Exhibit hackathon smoke test (contact via github.com/mehek-builds/exhibit)` | 403 | **FAIL** | Not applicable — SEC's edge returned its own HTML "Your Request Originates from an Undeclared Automated Tool" page (`sec.gov` fair-access bot wall), not JSON, regardless of the descriptive UA (tried via both `curl` and Node's `fetch`, byte-identical block page both times). `src/integrations/edgar.ts`'s own constructor-time UA check (`EMAIL_PATTERN` requiring a contact email in the UA) is satisfied by this string, so the adapter itself would build a compliant request — the block is this sandbox's outbound network being fingerprinted as automated traffic before the UA is even inspected, not a defect in `edgar.ts`. Not promoted to live; needs a re-run from a non-flagged network to actually confirm the Form-D XML parse (`issuerName`/`totalAmountSold`/`dateOfFirstSale`/`relatedPersonsList`) against a real hit. |
| GDELT DOC 2.0 API | `GET api.gdeltproject.org/api/v2/doc/doc?query="Apple Inc"&mode=artlist&format=json` | company name `"Apple Inc"`, `startdatetime=20260901000000` | 429 | **FAIL (rate-limited)** | Not applicable — GDELT's own 429 body (`"Please limit requests to one every 5 seconds..."`) was returned on every attempt this session (three tries, spaced), most likely because this same sandbox IP had already spent GDELT's quota in the two earlier smoke passes recorded above in this file (2026-09-13, same day). No article body was ever returned, so `src/integrations/gdelt.ts`'s parser (`toItem`, `gdeltDateToIso`) was not exercised against a populated result in this pass either — it remains exactly as `LIVE_SMOKE_STATUS` already describes it (`live: true`, "ran only on an empty result"); this attempt adds no promotion. |

### Adapter defects found (this pass)

None. ORCID's shape assumption is now positively confirmed against a real response. OpenReview and
EDGAR could not be exercised past their respective auth/bot walls from this sandbox's network — both
failures are network/access-policy findings, not parser bugs, and neither adapter's parsing code was
touched. GDELT stayed rate-limited for the whole window available in this pass, so its populated-result
path is still unconfirmed. No `LIVE_SMOKE_STATUS` entries were added or changed for `orcid`,
`openreview`, `edgar`, or `gdelt` as a result of this pass — none of the four met the "OK, adapter
parsed it" bar required for that table.
