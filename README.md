# Exhibit

Exhibit is an agent that builds a founder's O-1A visa and EB-1A green card evidence file while life
happens. It watches the places that evidence already lands (Gmail, Google Calendar, GitHub, LinkedIn,
and public sources the founder never saw), and files each real piece as a dated, sourced exhibit
under the right criterion in a private Google Drive binder, so the file is full before an attorney
ever asks for it.

**Exhibit is not legal advice.** It never states that anyone qualifies for a visa or green card. It
says which working rule an item meets, and it leaves anything uncertain for an attorney to decide.

## For judges

| # | Section | What's there |
|---|---|---|
| 1 | [Project overview](#1-project-overview) | What we built and the problem it solves |
| 2 | [External apps used](#2-external-apps-used) | The apps the agent connects to, what it reads and writes in each |
| 3 | [Setup instructions](#3-setup-instructions) | Run the demo in two commands, then the tests, then live mode |
| 4 | [Reliability testing](#4-reliability-testing) | How we tested it, the results, and what was simulated |
| 5 | [Demo video](#5-demo-video) | The two-minute video |

Fastest path: `npm ci && npx tsx src/cli.ts demo`. It runs offline in about a second, with no keys.

---

## 1. Project overview

### The problem

The O-1A is the standard visa for a founder who wants to work for their own US company, and the
EB-1A is the self-petitioned green card the same evidence can later support. Both require documents
proving at least 3 criteria (O-1A: 3 of 8, EB-1A: 3 of 10): the invitation to judge and proof you
judged, the article about you with its title, date and author, the award with its issuer and
selection criteria.

None of that arrives as a package. It is a judge invite in August, a podcast in November, a
citation the next spring, spread across an inbox, a calendar, GitHub and news the founder never
saw. Founders are told to "keep a folder." Almost nobody does, because the moment evidence lands is
the moment they are busiest. When an attorney finally asks, the founder spends weeks digging, misses
items, misdates others, and files things that do not count (funding is not an award; your own blog
post is not press about you).

### What we built

Exhibit does the filing continuously, and never adds anything without the founder's approval:

1. **Reads** Gmail, Calendar, GitHub and LinkedIn, and **discovers** evidence the founder never saw
   (news via GDELT, Hacker News, Product Hunt, podcasts, patents, peer review, SEC filings).
2. **Classifies** each item into an O-1A/EB-1A criterion, or rejects it with a reason. Known traps
   (funding as an award, a press release as press, a declined judge invite) are fixed rules in code.
3. **Verifies** the original date and issuer from the source itself.
4. **Files** the untouched original plus a content hash to a private Drive binder, then makes it
   tamper-evident (OpenTimestamps, Internet Archive).
5. **Corroborates** the numbers that give an exhibit weight (readership, citations, the
   90th-percentile wage) from official data, and every figure waits in a Google Sheet for the
   founder's approval.
6. **Reports** a scorecard in Google Docs (met, building or empty per criterion) with one concrete
   next action for the closest gap, and drafts recommendation-letter requests that go out only after
   the founder approves each one.
7. **Talks** over a two-way text thread (Twilio): six fixed commands (approve/deny, pause/resume,
   add evidence, next, status, stop), accepted only from the founder's verified number.

```mermaid
flowchart LR
  A[Gmail, Calendar,<br/>GitHub, LinkedIn] --> B[Classify + map<br/>to a criterion]
  D[Discovery: GDELT,<br/>Hugging Face, ...] --> B
  B --> C[Verify date,<br/>issuer, quote]
  C --> E[File to Drive binder<br/>hash + timestamp]
  E --> F[Corroborator:<br/>BLS, OpenAlex, web]
  F --> G[Review Sheet:<br/>founder approves]
  G --> H[Scorecard in Docs +<br/>letter requests]
  T[Text thread<br/>Twilio] <--> G
```

The whole build runs on **synthetic data only**: a fictional founder, "Dara Voss", over a fictional
year. No real inbox and no real immigration data are used anywhere in this repository.

---

## 2. External apps used

### The apps the agent connects to

Each has a real API client in `src/apps/live/`, turned on only when its credentials are present.

| App | What Exhibit does with it | Client | Access |
|---|---|---|---|
| **Gmail** | Reads mail for evidence (invites, acceptances, press). Sends letter requests only after the founder approves that exact message. Never deletes, archives or labels mail | `src/apps/live/google.ts` | Google OAuth2 |
| **Google Calendar** | Reads events as proof of service (a judging session that actually happened). Never creates events | `src/apps/live/google.ts` | Google OAuth2 |
| **Google Drive** | Writes the private evidence binder: the untouched original, a highlighted copy, a content hash. Checks that the binder is never shared | `src/apps/live/google.ts` | Google OAuth2 |
| **Google Sheets** | The review queue: every figure waits here for the founder's approve or deny | `src/apps/live/google.ts` | Google OAuth2 |
| **Google Docs** | The scorecard: each criterion as met, building or empty, with the next action | `src/apps/live/google.ts` | Google OAuth2 |
| **GitHub** | Reads repos, stars and code reviews on others' repos (judging evidence) | `src/apps/live/github.ts` | Personal access token |
| **LinkedIn** | Reads profile activity. There is no public API, so this runs against an Arga twin only | `src/apps/live/linkedin.ts` | Twin token |
| **Twilio** | The two-way text thread (SMS, WhatsApp Sandbox) | `src/apps/live/twilio.ts` | Account SID and auth token |
| **Anthropic (Claude)** | The classifier, criterion mapper, research model and text-command parser, through the Vercel AI SDK | `src/models/` | API key (optional, see below) |

### Evidence discovery and verification APIs

Every one is on a free tier and has its own adapter under `src/integrations/` or `src/integrity/`.

| Job | Integrations |
|---|---|
| Discover evidence the founder never saw | GDELT (world news), Hacker News, Product Hunt, Podcast Index, OpenReview, ORCID, Hugging Face Hub, SEC EDGAR (Form D), USPTO PatentSearch |
| Verify numbers from official data | OpenAlex, Crossref, Semantic Scholar (citations and journals), BLS and O\*NET (90th-percentile wage for the occupation code), ecosyste.ms (package adoption) |
| Make the binder tamper-evident | OpenTimestamps (each file's hash is stamped, later anchored in Bitcoin), Internet Archive Save Page Now (dated third-party copies of public sources) |
| Act | Dropbox Sign (letters out for signature, test mode), DeepL API Free (draft translations of opt-in, redacted text) |
| After filing | USCIS Case Status API (Torch): sandbox only, production access pending USCIS approval |

### What ran against the real service, stated plainly

- **Keyless live smoke test (2026-09-13):** Hacker News, Crossref, BLS, ecosyste.ms, the GitHub REST
  API, the Internet Archive availability API and one OpenTimestamps calendar each ran against the real
  endpoint and parsed correctly. GDELT answered live with zero hits for the query. Semantic Scholar was
  inconclusive. Full record: [docs/integrations/LIVE-SMOKE.md](docs/integrations/LIVE-SMOKE.md).
- **Google Workspace, GitHub, LinkedIn and Twilio** are exercised end to end in the graded scenarios
  through twins (in-memory copies of each app that record every read and write, see section 4). The
  live clients are built and wired, and run on the founder's real accounts after the event.
- **Without `ANTHROPIC_API_KEY`**, Exhibit runs a deterministic heuristic stand-in
  (`src/models/heuristic.ts`) instead of Claude, and says so in its startup report. Every graded run
  in this repository used that stand-in so results are reproducible without a key.

---

## 3. Setup instructions

### Prerequisites

- Node.js 22.13 or newer (`node --version`)
- npm
- No API keys are needed for the demo, the tests or the graded evaluation

### Run it (offline, no keys)

```bash
git clone https://github.com/mehek-builds/get-your-o1-visa.git exhibit
cd exhibit
npm ci
npx tsx src/cli.ts demo                    # the two-minute demo over Dara Voss's synthetic year
npx tsx src/cli.ts verify --demo out/demo  # re-checks the exported binder; catches the one altered file
```

What you should see from `demo`: 18 exhibits filed, the scorecard (O-1A 7 of 8 criteria met, EB-1A
7 of 10), 6 figures queued for review, text-channel decisions applied, one letter request held and
one sent after approval, and 43 files stamped with 1 altered file caught by name. Everything is
exported to `out/demo/` (the Drive binder, `scorecard.txt`, `review-sheet.csv`, `sent-mail.json`,
`trace.jsonl`, `ledger.json`, `audit.json`). A committed slice of one run is in
[docs/sample-output/](docs/sample-output/).

The demo deliberately changes one filed file after stamping it, so `verify --demo` reports 42
confirmed files, names `original.eml` as altered, and exits with status 1. That failure is the
expected proof that tampering is detected. The demo's timestamp chain is synthetic and lives in the
same export, so this is an internal consistency check; live `verify` checks Bitcoin attestations
against block headers fetched independently from Blockstream.

### Run the tests and the graded evaluation

```bash
npm run check                              # typecheck + 960 unit tests + the rule check
npx tsx src/cli.ts eval --attempts 3       # every scenario, 3 graded attempts each (about 15s)
npx tsx src/cli.ts mutate                  # disables key rules one at a time; each must turn a scenario red
npx tsx src/cli.ts prove-rules             # re-runs the scenarios behind any changed rule fragment
npx tsx src/cli.ts brief --out BRIEF.md    # regenerates the reliability brief from the latest reports
```

Reports are written to `reports/` (JSON). `npx tsx src/cli.ts help` lists every command.

### Run it live on real accounts

1. `cp .env.example .env`. The file documents every variable, grouped by app.
2. Open `web/setup.html` and fill in the one-screen setup (what Exhibit does and never does, your
   accounts, phone number, quiet hours). It generates the `EXHIBIT_PROFILE` JSON string.
3. Set the live core: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` (Gmail,
   Calendar, Drive, Sheets, Docs), `GITHUB_TOKEN`, `EXHIBIT_OWNER_EMAIL`, `EXHIBIT_PROFILE`.
4. Optional: `ANTHROPIC_API_KEY` for Claude (otherwise the lower-recall heuristic runs and the startup
   report says so), `TWILIO_*` for the text thread, and any discovery or verifier keys you want.
   Every integration turns on only when its own credentials are present, and the startup report lists
   what did and did not load.
5. Run it:

```bash
node --env-file=.env node_modules/.bin/tsx src/cli.ts run --live     # one pass
node --env-file=.env node_modules/.bin/tsx src/cli.ts watch --live   # repeats on an interval (min 60s)
node --env-file=.env node_modules/.bin/tsx src/cli.ts serve          # Twilio webhook plus the scheduled run
node --env-file=.env node_modules/.bin/tsx src/cli.ts verify         # re-check the live binder
```

---

## 4. Reliability testing

### How we tested it

Exhibit is proven before it touches a real inbox, and checked again on every run. Four checks, each
answering a different question:

| Question | Check | Where |
|---|---|---|
| Does it do the right thing, and nothing else, before it touches real data? | **Graded scenarios on twins**: 28 scenarios, 3 attempts each, graded from what the twins hold afterwards, never from Exhibit's own logs | `harness/scenarios/`, `npx tsx src/cli.ts eval` |
| On real runs, does it follow its own rules? | **Trace audit** of every run against seven failure modes (skipped work, out-of-scope work, instruction violation, integration failure, retry loop, hallucination, communication failure) | `src/observability/audit.ts` |
| When it contacts a person, was the message worth sending? | **Userlens worth-sending gate** on every letter request and every proactive text; a `send` still needs the founder's approval | `src/letters/worthSending.ts` |
| When a rule changes, what did it touch, and was that re-proven? | **Prompt-graph dependents check**: the criterion rules are shared fragments; changing one lists every prompt that uses it and re-runs the scenarios behind them | `src/rules/graph.ts`, `npx tsx src/cli.ts prove-rules` |

Plus two guards on the tests themselves:

- **Mutation check.** `npx tsx src/cli.ts mutate` disables one rule at a time (accelerator
  acceptance, funding-is-not-an-award, the second-identifier rule, verified-number texts,
  confirm-before-irreversible, translation opt-in, the press-release trap, the EB-1A-only exhibition
  rule, the tamper check, both signing approvals) and confirms the scenario that covers it goes red.
  This guards against a scenario that would pass no matter what the code does.
- **Degraded modes.** When Gmail, Calendar, Drive, Sheets, Docs, GitHub, search or a verifier API
  fails, the run records that app as degraded and keeps going, never silently substituting a weaker
  source; queued work retries once the app is back (`test/degraded.test.ts`, scenario S15).

### What the scenarios cover

Each scenario seeds the twins with a known answer and a known trap:

- **S1** the full synthetic year: the right exhibits, criteria and dates, with the scorecard at 7 of 8
- **S2 to S8** the classification rules and traps: accelerator acceptance under two criteria, a SAFE
  is never an award, the founder's own article is not press, declined and unanswered judge invites,
  forwarded press keeps its original date, one article from two sources is one exhibit
- **S9** an instruction injected inside an email is treated as data
- **S10, S11, S19, S19b, S19-record** letter requests: held by the send gate, sent exactly once after
  two approvals, and the agent never reads its own approval-request email as the founder's approval
- **S12** identity numbers (passport, A-number, SEVIS id) never reach a model call or a trace
- **S13** a re-run files, drafts and sends nothing new
- **S14, S15** a pre-shared Drive folder, and LinkedIn going down mid-run
- **S16, S17, S18** O-1A versus EB-1A status, figure sourcing rules (conflicts, invented figures), and
  only approved figures reaching Drive
- **S20, S26** the text channel: unknown numbers, unclear texts, "approve all", quiet hours
- **S21 to S25** discovery with a namesake and a look-alike filing, tamper detection, signing, the
  translation opt-in, and every extension enabled together

Prohibited side effects asserted on every attempt: an email without approval, a text acted on from an
unknown number, a text in quiet hours without a send decision, an email to an attorney or government
domain, any Drive or Sheets share, a changed hash on a filed file, any mail deleted, archived or
labeled, any calendar event created, any LinkedIn post, and an identity number in a trace.

### Results (2026-09-14, release `03596db`)

| Measure | Result |
|---|---|
| Graded attempts passed | **84 of 84** (28 scenarios x 3 attempts) |
| Prohibited side effects across all attempts | **0** |
| Traps filed as qualifying | 0 of 5 |
| Must-count items filed as qualifying | 5 of 5 |
| Exhibit dates matching the source | 15 of 15 |
| O-1A and EB-1A status correct | 17 of 17 |
| Rule mutations caught (scenario went red) | **10 of 10** |
| Unit tests | 960 of 960 |
| Demo tamper check | 42 untouched files pass, the 1 altered file is caught by name |

These are from our own run of the commands in section 3. Re-run them to reproduce; the full
generated brief with every table (audit issues, worth-sending hold rate, figures proposed and
rejected, discovery results by source) is [BRIEF.md](BRIEF.md).

### What was real and what was simulated

- The twins in `src/twins/*.ts` are **in-memory copies built for this project**, not Arga Labs'
  hosted twins. The Arga backend (`--backend arga`, [docs/ARGA.md](docs/ARGA.md)) is built for
  running the same matrix on Arga's hosted twins when `ARGA_API_KEY` is set; the results above used
  the in-memory backend.
- Every graded run used the deterministic stand-in model, not a live Claude call (see section 2).
- The outlets, journals and programs in the synthetic year are fictional `.example` domains, and every
  discovery and verifier response in the harness is a **recorded fixture** replayed without network.
- Clera's uberprompt is not run (no public license was available to this build). Exhibit implements
  its own dependents check over the same shared-fragment prompt-graph file format instead.

---

## 5. Demo video

**Video (2:00):** _link to be added_

The video follows the presenter script in [docs/DEMO-SCRIPT.md](docs/DEMO-SCRIPT.md), recorded from
`npx tsx src/cli.ts demo`, so every number on screen can be reproduced with the commands in section 3.

---

## Repository map

| Path | What's there |
|---|---|
| `src/agent.ts` | The one run loop: intake through scorecard, plus the text-channel and integration hooks |
| `src/pipeline/`, `src/rules/` | Classify, map, verify; the criterion prompt graph and trap rules |
| `src/binder/`, `src/review/` | Drive filing, scorecard rendering, the review queue |
| `src/research/`, `src/integrations/` | The Corroborator and every discovery and verifier adapter |
| `src/letters/`, `src/text/`, `src/notify/`, `src/discovery/`, `src/integrity/`, `src/translate/` | Letter requests and signing, the text channel, notifications, discovery, tamper-evidence, opt-in draft translation |
| `src/commands/`, `src/server/`, `src/loop/`, `src/setup/` | `verify`/`serve`/`loop` commands, the Twilio webhook, lifted-scenario loop, founder profile setup |
| `src/twins/`, `harness/` | In-memory twins, fixtures, the graded scenario matrix (`harness/scenarios/`), fault injection, the Arga backend |
| `src/apps/live/`, `src/config.ts` | Real app clients, wired only when their env vars are present |
| `src/demo.ts`, `src/cli.ts` | The two-minute demo and the `exhibit` CLI |
| `docs/PRD.md`, `docs/ARCHITECTURE.md` | The spec and the code map |
| `docs/ARGA.md`, `docs/LLM-PATH.md`, `docs/SECURITY-REVIEW.md`, `docs/integrations/` | Arga backend notes, the Claude model path, the security review, live-smoke and OpenTimestamps notes |
| `docs/DEMO-SCRIPT.md`, `docs/sample-output/` | The two-minute presenter script and a committed slice of one demo run |
| `BRIEF.md`, `prompts/` | The generated reliability brief; the prompt graph, rule proofs and rule-change records |
| `constraints/hard-constraints.md` | The 19 hard rules, mapped to enforcement |

## Privacy and safety

The rules are enforced as described in [constraints/hard-constraints.md](constraints/hard-constraints.md)
and mapped to code in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). In short: identity numbers are
redacted before any model call or log (`src/pipeline/redact.ts`); each integration receives only its
minimum (public pages to the Internet Archive, hashes to OpenTimestamps, redacted opt-in text to
DeepL); the binder is never shared; Exhibit never writes to a source app; and no email goes to an
attorney or government domain.

## License

No license specified yet.
