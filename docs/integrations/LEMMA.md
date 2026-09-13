# Lemma (PRD 6.10, 7.2)

## Tracing (automated)

Every run is one Lemma trace named `exhibit`. Model calls go through the Vercel AI SDK
integration; Gmail, Calendar, Drive, Docs, GitHub, LinkedIn and worth-sending calls are recorded
with `trace.recordTool()`. This is wired up in code and needs no manual step beyond setting
`LEMMA_API_KEY` / `LEMMA_PROJECT_ID` (see `.env.example`).

## Constraints upload (manual, one-time)

PRD 6.10 says "Exhibit's hard constraints (section 8) are uploaded as a Lemma Artifact so Lemma
audits every trace against them." `@uselemma/tracing` 7.12.0 has **no artifact, document, or
instructions upload API** — checked directly against its `.d.ts` files, which expose only
trace/span/tool/generation recording and the framework integrations (vercel-ai, langchain, mastra,
openai-agents, coding-agent).

So `src/observability/lemmaArtifacts.ts` does not invent an endpoint. It is an honest stub:
`uploadConstraints()` always returns `{ uploaded: false, reason: '...' }` and does nothing else.

**What to actually do:** paste the contents of `constraints/hard-constraints.md` into the Lemma
UI by hand (project settings → Artifacts, or wherever the current Lemma UI exposes artifact/
instructions text) once, and again any time that file changes. Treat this the same as any other
manually-maintained config in a third-party dashboard — there is nothing for `exhibit` to automate
here until Lemma ships an upload API.

## Issue webhooks

`issue.created` / `issue.resolved` webhook events post to the founder's own inbox during the
build (PRD 6.10). This part *is* automated: see `src/server/lemmaWebhook.ts`, wired into
`exhibit serve` (`src/commands/serve.ts`) behind `LEMMA_WEBHOOK_SECRET`. Configure Lemma's project
webhook settings to POST to `<public host>:<port+1>/` with a shared secret matching
`LEMMA_WEBHOOK_SECRET`, signing the raw body as `X-Lemma-Signature: HMAC-SHA256(body, secret)`
hex-encoded. The recipient is always the founder's own profile email; nothing in the webhook
payload can redirect it.
