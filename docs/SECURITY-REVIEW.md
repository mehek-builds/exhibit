# Exhibit — Security & Privacy Review

Reviewed against `constraints/hard-constraints.md` (19 constraints) and `docs/PRD.md` §6.2, 6.9,
6.13, 6.14 (integration data table), 8, 11, ahead of pushing this repo public for a hackathon.

## Findings

### High

**H1 — `reports/` is not gitignored and contains eval output with 100+ KB–1 MB JSON files**
*Status: fixed 2026-09-13 — `reports/` is in `.gitignore`.*
`.gitignore` excludes `node_modules/`, `.exhibit/`, `out/`, `.env*`,
`*.db`, `coverage/` — but not `reports/`. The repo has no commits yet (`git status` shows
"No commits yet"), so nothing has leaked yet, but `git add -A` / `git add .` on the first commit
would publish `reports/eval-batch_*.json`, `reports/eval-latest.json`, `reports/mutation-latest.json`
(largest is 1,079,078 bytes) to a public repo. Spot-checked contents are synthetic fixture data
(`alex@quietfield.example`, etc.) with no real PII found in this pass, but these are harness run
artifacts that will keep regenerating and are exactly the class of file that should never be
committed by accident (could contain a future run's real model output, a leaked trace, or simply
bloat the public repo with junk).
**Patch:** add `reports/` to `.gitignore` (matching the `out/` treatment already given to the other
generated-output directory), and confirm nothing under `reports/` is already staged before the
first commit (`git status` currently shows it untracked, so a plain gitignore add is sufficient).

### Medium

**M1 — Raw integration error bodies can reach the trace log unredacted**
*Status: fixed 2026-09-13 — error bodies pass through `safeErrorBody` (truncate + redact) in `src/integrations/types.ts`, used by the Dropbox Sign, DeepL, USCIS and Twilio clients.*
`src/integrations/uscis.ts` (~L78, L93), `src/integrations/dropboxsign.ts` (~L111, L118),
`src/integrations/deepl.ts` (~L51), `src/apps/live/twilio.ts` (~L79, L89) throw errors of the shape
`` new Error(`... ${res.status} ${res.body}`) `` where `res.body` is the raw HTTP response text from
the external service. These errors are then passed to `trace.tool(..., undefined, String(err))`
(see `src/observability/tracer.ts`) and persisted to the trace JSONL. `scrubForBoundary` in
`src/pipeline/redact.ts` (used at the trace boundary) only pattern-matches identity numbers
(passport/A-number/SEVIS/I-94/DOB/address) — it does not scrub arbitrary content. If a 4xx
validation response from Dropbox Sign or Twilio echoes back a submitted field (a common API
pattern — e.g. Twilio echoing an invalid `Body` param, which could itself be founder text that
wasn't meant to leave the process, or DeepL echoing the untranslated source text on a quota error),
that raw content lands in the trace file unredacted. This is a real gap in constraint 8's "never
send unredacted identity numbers to a model, a trace or a log" guarantee, since the guarantee
currently rests entirely on the identity-number regexes catching whatever comes back.
**Patch:** run `res.body` (or the constructed error message) through `redactText()` before
interpolating it into the thrown `Error`, or truncate to a fixed length (e.g. first 200 chars) and
strip anything past the HTTP status line, in each of the four files above.

**M2 — Twilio webhook has no request body size cap**
*Status: fixed 2026-09-13 — `src/server/webhook.ts` rejects bodies over 64 KB with 413 before signature validation.*
`src/server/webhook.ts` `readBody()`:
```ts
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
```
This buffers the entire POST body into memory with no limit, and it runs *before* the
`X-Twilio-Signature` check, so signature validation cannot reject an oversized request early. Since
this endpoint must be internet-reachable for Twilio to POST to it, anyone who discovers or guesses
the URL can send an arbitrarily large body and exhaust memory on the process before the signature
check ever runs — a low-effort DoS against the same process that runs the immigration-evidence
pipeline.
**Patch:** track cumulative byte length while reading and abort/respond 413 past a small cap (e.g.
64 KB — Twilio webhook bodies are form-encoded and small), before or interleaved with the read loop.

### Low

**L1 — Inbound SMS body stored unredacted in the ledger**
*Status: fixed 2026-09-13 — `src/text/channel.ts` redacts message bodies before `text_in` / `text_out` ledger events.*
`src/text/channel.ts:143`:
```ts
deps.ledger.event({ run_id: runId, trace_id: trace.traceId, kind: 'text_in', detail: { sid: msg.sid, from: msg.from, body: msg.body, command, args, action }, at: now.toISOString() });
```
`msg.body` (the raw founder text) is written to the ledger without going through `redactText`. Line
138's `text_out` event has the same shape for outbound text. If the founder ever pastes/forwards a
passport number, A-number, or DOB into a text reply, it lands in the ledger — which is used to
render the scorecard/audit trail (constraint 11: "the scorecard, the ledger and Drive must agree")
and is a lower-friction leak path than the model/trace paths, which are redacted consistently
elsewhere (`src/agent.ts` redacts every item before anything downstream sees it, including model
calls). This is inconsistent with the redaction discipline applied everywhere else in the pipeline.
**Patch:** apply `redactText(msg.body).text` before writing `body` into both `text_in` and
`text_out` ledger event details in `src/text/channel.ts`.

## Checked and fine (coverage notes)

- **Constraint 8 / model-call redaction path:** `src/agent.ts` redacts every item via `redactItem`
  immediately after intake/discovery and before classification; everything downstream (model calls,
  ledger `markItem`, filer) uses the redacted copy — only the filer touches `raw`. Confirmed by
  reading the intake→redact→classify sequence directly.
- **Constraint 17 / integration data minimization:** GDELT query construction, DeepL (opt-in +
  redacted text only), Internet Archive (public URLs only), OpenTimestamps (sha256 hash only), and
  Dropbox Sign gating were reviewed against the PRD's "what each integration receives" table with no
  additional over-send found beyond the error-body issue in M1.
- **Approval gates (constraints 1, 13, 18):** `approvalFor()` in `src/letters/letters.ts` /
  `src/letters/signing.ts` excludes agent-authored ledger entries from counting as an approval;
  Dropbox Sign requests are gated on both recommender confirmation and founder approval plus
  test-mode/day-mode checks; `src/text/commands.ts` routes through the same gated code paths rather
  than a separate send path.
- **Webhook signature validation:** `src/server/webhook.ts` `twilioSignature()`/`safeEqual()` use
  `crypto.timingSafeEqual` (constant-time) and reconstruct the exact configured public URL per
  Twilio's documented algorithm — the size-cap gap in M2 is the only issue found here.
- **Prompt injection:** item/fetched content is wrapped as inert data with explicit anti-injection
  framing before model calls; outputs are schema-constrained; no path found where fetched content or
  inbound text could alter agent control flow directly.
- **Secrets:** no hardcoded API keys/tokens found in `src/`, `docs/`, `constraints/`, `prompts/`, or
  test fixtures; `.env.example` contains placeholder names only; `web/setup.html` does not transmit
  profile data anywhere; `.gitignore` correctly excludes `.env*`, `.exhibit/`, `*.db`.
- **Public-repo privacy scan** (a case-insensitive search for the author's personal identifiers and
  private-note terms, excluding `node_modules`/`out`/`reports`): the only hits are the public author
  name in `package.json`, the public repository clone URL in `src/brief.ts`, and a generic
  external-resource title in `docs/PRD.md` sources — no real addresses, phone numbers (all test
  numbers are Twilio's public sandbox number `+14155238886` or synthetic fixture digits), or
  immigration-status details about a real person were found.
- **Constraint 19 / claims honesty:** `src/brief.ts` derives "live" language from actually-recorded
  trace events; `src/integrations/uscis.ts` is labeled sandbox-only in its header comment; no
  instances found describing Arga/Lemma/uberprompt as a hosted/production service when only a
  twin/fixture was used.
