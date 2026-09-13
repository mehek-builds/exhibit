# Sample output

A small, committed slice of one real run of Exhibit's demo, so a judge can see what the agent
produces without running anything.

**How this was generated.** `npx tsx src/cli.ts demo --out out/sample-run`, run on 2026-09-13, on
this repository's `src/demo.ts` (PRD section 14). `out/` is gitignored; the files here are a
curated copy of that run's output.

**What ran, honestly:**
- **Backend:** `ANTHROPIC_API_KEY` was not set for this run, so every model call went through
  Exhibit's deterministic heuristic stand-in model (`src/models/heuristic.ts`), not a real LLM call.
- **Data:** everything comes from the in-memory twins (`src/twins/*.ts`), seeded with the fictional
  founder **Dara Voss** and a synthetic year (`harness/corpus.ts`). No real inbox, calendar, Drive,
  GitHub or immigration data was used.
- **Web/API calls:** every discovery and verifier-API response (GDELT, BLS, the outlet media-kit and
  audit-body pages, etc.) is a recorded fixture (`harness/fixtures/*.ts`) replayed through a
  `FixtureTransport` — no real network call was made.
- **Numbers:** every count and figure in these files (18 exhibits filed, "O-1A 7 of 8", the BLS wage
  figure, etc.) is from this one run only. Re-running will very likely produce different numbers as
  the demo and corpus evolve; nothing here is hardcoded elsewhere in the repo.
- **People and outlets:** Dara Voss, Loomwork, Forge Accelerator, Ridgeline Fellows, Devtools
  Weekly, Build Night, HackMesa, and every other person, company and outlet in this folder are
  fictional constructs of the demo corpus.

## Files

| File | What it is |
|---|---|
| `scorecard.md` | The regenerated scorecard text (PRD 6.7) from the end of the run: criteria met per route, the GO-trigger view, the next action, letters, and the not-counted summary |
| `index.md` | The binder's per-criterion index (PRD 6.6), one line per exhibit |
| `not-counted.md` | Items the agent considered and excluded, grouped by reason, so an attorney can see what was left out and why |
| `review-sheet.csv` | The Exhibit review Sheet (PRD 6.12) as the founder would see it: one row per researched figure, both sources, the label, and her Approve/Deny decision |
| `sent-mail.json` | Every message in the sent folder at the end of the run: the founder's own seeded replies to judge invites, self-notices to her own address (figures waiting, two letter approvals requested, the first scorecard) and the one letter request sent after her `APPROVE` reply. The third letter (LTR-marco) was held by worth-sending because Marco had just written that he was busy, so no approval was even requested for it. No message went to anyone else without her approval |
| `first-scorecard-notice.md` | The first-scorecard notification content and the worth-sending decision that approved it — this run didn't emit a literal WhatsApp text event, so the equivalent self-notice email body is shown instead, and that gap is called out in the file |
| `audit-trimmed.json` | This run's Lemma-mirror audit findings (`src/observability/audit.ts`) — one hallucinated figure the code caught and discarded before it could reach the review queue |
| `exhibits/EX-1-001-accelerator-acceptance/` | An awards/membership exhibit (`metadata.json`, `render.pdf`, `context-notes.md`) with an approved, issuer-confirmed context figure written in — shows the filer, the officer-ready render, and the Corroborator flow end to end |
| `exhibits/EX-4-002-judging/` | A judging exhibit (`metadata.json`, `render.pdf`, `original.eml`) showing an untouched original alongside its render |
| `exhibits/EX-1-003-needs-attorney/` | An item routed to `needs-attorney` (`metadata.json`, `render.pdf`) because the issuer states no selection criteria — shows a trap rule catching an item Exhibit won't call qualifying on its own |

## Regenerating

```bash
npm ci
npx tsx src/cli.ts demo --out out/sample-run
```

Then copy whichever files you want from `out/sample-run/` (gitignored) — see the table above for
which ones this folder tracks and why.
