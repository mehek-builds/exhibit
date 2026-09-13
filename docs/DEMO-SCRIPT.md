# Exhibit — presenter script (2:00)

Founder on screen: **Dara Voss** (fictional, synthetic year only — no real inbox, no real
immigration status, no judge named or implied). This script is written for and verified against a
real run of:

```
npx tsx src/cli.ts demo --out out/demo-script-run
```

Every number below is quoted from that run's console output or its exported files in
`out/demo-script-run/`. The "source" column names the console line or file it came from — re-run
the command yourself before presenting; if your numbers differ, use *your* run's numbers, not
these.

## Timed script

| Time | On screen | Say | Source |
|---|---|---|---|
| 0:00–0:15 | Terminal, empty prompt | "Every guide tells a founder on a visa to keep a folder of evidence. Almost nobody does, because the evidence arrives when they are busiest." | PRD 14 opening line (verbatim, generic) |
| 0:15–0:50 | Run `npx tsx src/cli.ts demo --out out/demo-script-run`, let Run 1 scroll | "This is Exhibit running over a synthetic year for a fictional founder, Dara Voss. It just filed 18 exhibits into a Drive binder — hashed, dated, sourced." | `Exhibits filed: 18 (EX-4-001, ... EX-3-007)` |
| | Point at scorecard lines | "One binder, two visas: O-1A 7 of 8 criteria met, EB-1A 7 of 10 criteria met." | `O-1A: 7 of 8 criteria met (3 required).` / `EB-1A: 7 of 10 criteria met (3 required).` |
| | Point at "Discovery" block | "It also found this — a news article about Dara that was never in her inbox, surfaced by GDELT." | `"Dara Voss of Loomwork raises the bar for AI infrastructure" ... — found by GDELT only, not in Gmail` |
| | Point at "#8 salary benchmark" block | "The salary benchmark on exhibit 8 is pulled from a structured wage-data adapter — in this build it's a synthetic fixture standing in for BLS, so treat the number as a stand-in, not a published figure." | `FIG-010: 240000 USD per year (SYNTHETIC fixture, not a published BLS figure) — status insufficient_sources` |
| 0:50–1:10 | Open `out/demo-script-run/scorecard.txt` | "Here's what founders miss and misfile. #1 and #2 overlap on purpose — the accelerator acceptance counts as both an award and a membership. Exhibit also caught a trap: a press release about the company, not about Dara, doesn't count as press." | scorecard.txt "Not counted, by reason:" block: `T-press-release: 1`, `T-self-authored-not-press: 1`, `T-invite-declined: 1` |
| | Point at "Next action" line | "And it tells her what to do next: criterion 6 is empty, but a talk at a major conference counts as comparable evidence — submit a talk proposal." | `Next action: #6 Scholarly articles is empty: a talk at a major conference counts (comparable evidence); submit a talk proposal` |
| 1:10–1:30 | Open `out/demo-script-run/review-sheet.csv` | "Every figure Exhibit wants to use gets a human decision first. This run queued 6 figures for review. I'll act as Dara: approve two, deny one — here, the visitor count doesn't clearly match the exhibit, so it's denied with a reason." | `Figures queued: 6` list; `Founder approves FIG-001, FIG-003; denies FIG-004.` |
| | Point at text-channel block | "The same approval can come in by text. Here Exhibit received 'approve 1, deny 2, old rate' and applied it: figure 1 approved, figure 2 denied with the reason 'old rate' attached." | `#1 (FIG-001) -> approved` / `#2 (FIG-003) -> denied (reason: old rate)` — note: this run's in-memory Twilio fake, not a live WhatsApp send |
| 1:30–1:40 | Point at "Run 2" and "Letters" blocks | "One hour later, the approved figure is written into the exhibit's notes, the denied one appears nowhere in the binder. One letter request was held because the recommender had just said he was busy; another went out only after Dara replied APPROVE by email." | `FIG-001: written to context-notes.md` / `FIG-004: appears nowhere in the binder (denied)` / `held: LTR-marco — Timing is below the required minimum of 2/4.` / `sent (after APPROVE): LTR-priya` |
| 1:40–1:50 | Point at "Integrity" block | "Now the tamper check. Every file in the binder is stamped; I altered one on purpose, and `exhibit verify` catches it by name." | `stamped: 43, verify passed: 42, pending: 0, failed: 1` / `tampered file: original.eml — caught by name (original.eml)` |
| 1:50–2:00 | Point at closing summary lines | "Today I changed a rule: accelerator acceptance now counts under #1 and #2. The dependency check found 3 prompts that use that rule — the mapper, the scorecard writer, the letter drafter — mapped to 8 scenarios. This run's own audit caught one thing no scenario predicted: a hallucinated figure, discarded before it reached the binder." | `The dependents check ... found 3 prompt(s) ... (letter-drafter, mapper, scorecard-writer), exercised by scenarios S1, S2, S3, S4, S6, S10, S11, S16.` / `audit.json`: one issue, `"mode": "hallucination"` |
| | Close | "Judging today counts. If anyone here is on a visa, an agent like this just filed it for them." | PRD 14 closing beat, generalized (no judge named) |

## Setup checklist (run before presenting)

1. `npm ci` (once, ahead of time — no installs during the demo window).
2. `npx tsx src/cli.ts demo --out out/demo-script-run` — run it once beforehand to confirm it completes clean (no `[skipped: ...]` lines) and to generate the files below. Run it again live for 0:15–1:50.
3. Have these files open in tabs/editor before you start:
   - Terminal, ready to run the command above.
   - `out/demo-script-run/scorecard.txt`
   - `out/demo-script-run/review-sheet.csv`
   - `out/demo-script-run/audit.json`
4. If `reports/eval-latest.json` does not exist, the closing line prints "Latest scenario pass rate: run eval" instead of a number. Run `npx tsx src/cli.ts eval --attempts 3` beforehand if you want the pass count, percentage, and backend in the closing beat, and re-check the console line before speaking a specific rate.
5. Do a fresh `npx tsx src/cli.ts demo --out out/demo-script-run` within an hour of presenting and re-read every number in this table against that run's console output before you go on. If any line differs, say the number on your screen, not the one printed here.

## Differences from PRD 14

The PRD's script was written before this run existed. This build changes or drops the following
PRD 14 beats because the actual output does not support them as written:

- **No hosted Arga twins on screen.** The binder, scorecard, and figures shown are graded from
  Exhibit's own in-memory twin state (`env.twins.state()`), not a hosted Arga session. The proof
  loop's "3 of 3" pass-rate line only appears if `reports/eval-latest.json` exists from a prior
  `eval` run; otherwise the script says "run eval" and the presenter should not claim a number.
- **The audit's catch is a hallucination.** "The audit caught one thing no scenario predicted"
  refers to the trace audit (in `out/demo-script-run/audit.json`), which caught one issue under the
  seven failure modes (PRD 12.4): a `hallucination` (a figure the model tried to cite that wasn't
  actually on the fetched page). It has not been lifted into a new scenario in this run.
- **No uberprompt run.** The dependency check ("3 prompts depend on it") comes from Exhibit's own
  `affected()` function over its internal prompt-dependency graph (`src/rules/graph.ts`), written
  in the format uberprompt's `affected` command would consume — not a Clera uberprompt process.
- **No real WhatsApp message.** The "approve 1. deny 2, old rate" exchange runs entirely through
  `MemoryTwilio`, an in-memory fake — no message left this machine and no WhatsApp Sandbox is
  involved. Say "text channel," not "WhatsApp," unless you have separately verified a live Sandbox
  send before presenting.
- **BLS figure is a fixture.** #8's wage benchmark comes from a fixture transport standing in for a
  BLS adapter, seeded with a synthetic number (240000 USD/year) — not a live call to BLS. Say
  "synthetic" out loud, per the script above.
- **Closing line kept, scoped down.** "Judging today counts. If anyone here is on a visa, an agent
  like this just filed it for them" is kept as a true, general statement about what the tool does —
  it names no judge and claims nothing about any real person's status, consistent with PRD section
  0 item 6.

## Likely judge questions

**"What actually ran live, versus what's canned?"**
Everything shown ran live in this session, end to end, against Exhibit's own code — but "live" here
means an in-memory synthetic year (Gmail/Calendar/Drive/Sheets/GitHub twins) with fixture
transports standing in for GDELT, BLS, and Dropbox Sign, plus an in-memory Twilio fake for the text
channel. No real inbox, no hosted Arga session, and no real network call
left the machine during the demo. The classify → verify → file → corroborate → review pipeline is
the real code path; what's synthetic is the founder's data and the external services' *responses*
to that code, not the code itself.

**"How do you know it doesn't file a SAFE as an award?"**
The scorecard's "Not counted, by reason" section shows Exhibit's trap rejections working — this run
excluded a declined invite, a press release, and a self-authored piece with named reasons. The PRD's
trap set (5.5) treats a SAFE specifically as counting toward remuneration, not as an award — this is
enforced by the classifier's criterion rules and is exercised by scenarios in the Arga scenario
matrix (S1–S9, S16 per PRD 12.6), not asserted from the demo run alone. Ask to see
`out/demo-script-run/scorecard.txt`'s "Not counted, by reason" section and the criterion mapping
rules in the codebase.

**"What stops it emailing a recommender without approval?"**
Every letter request goes to `held`, `awaiting approval`, or `sent` — never `sent` without a
preceding approval action, per this run's own log: 3 letters were drafted; worth-sending held one
(LTR-marco, whose recent email said he was busy), two sat "awaiting your approval," and the 1 that
sent did so only after the founder's `APPROVE LTR-priya` reply was recorded. The agent's own
approval-request email is never read as the founder's approval (scenario S19). That's Userlens'
worth-sending decision plus a required human approval step (PRD 12.6), and the ledger records a
decision and reason for every letter — see `Letters: drafted 3, held 1, awaiting approval 2, sent 0`
before approval, and `sent (after APPROVE): LTR-priya` after it, in this run's console output.
