# The Claude (LLM) path: what is verified, what is not

This machine has no `ANTHROPIC_API_KEY`, so every graded run to date has used
`HeuristicModel` (`src/models/heuristic.ts`), a deterministic keyword stand-in. This
document is the readiness state of the real path — `AnthropicModel` (`src/models/anthropic.ts`),
`AnthropicResearcher` (`src/research/anthropic.ts`), and `AnthropicCommandParser`
(`src/text/commands.ts`) — and the first thing to run against it once a key exists.

## Verified without a key

Everything below was exercised with a mocked `LanguageModelV4` (`ai/test`'s
`MockLanguageModelV4`) or a mocked `Anthropic` client, in `test/llm-path.test.ts`. No network
call was made; `ANTHROPIC_API_KEY` was never read.

- **Request shape.** `AnthropicModel` defaults to model id `claude-sonnet-5`, is schema-constrained
  via `Output.object` (Zod schemas matching `ModelClassification`/`ModelMapping`), retries once on
  a schema-validation failure, and aborts a call after a configurable timeout (default 30s),
  counting an abort as a retryable failure (E29).
- **`AnthropicResearcher` request shape.** Model id `claude-sonnet-5`, both server tools declared
  with the exact types `web_search_20260209`/`web_fetch_20260209`, `allowed_domains` threaded
  through unchanged from the caller, `max_uses` applied to both tools, and no code execution tool
  declared alongside them (7.5b).
- **Server-tool error handling.** A `*_tool_result` block whose `content` is a single object with a
  `type` ending in `_error` is parsed into `ResearchResult.errors` and never thrown (7.5b); a
  request-level failure (network/auth) is also caught and returned as an error, not thrown.
- **Never sends founder personal data to research.** The research prompt is built from only
  `issuerDomain`, the criterion number, and its fixed measure list — asserted by an explicit test
  that the founder's name and email never appear in the request.
- **Defense-in-depth boundary check.** Both `AnthropicModel` and `AnthropicResearcher` run
  `scrubForBoundary` (the same function the tracer uses, `src/pipeline/redact.ts`) on the exact
  prompt about to leave the process and throw `BoundaryLeakError` if anything is still
  redactable — independent of whether `redactItem` upstream did its job.
- **Mapper safeguards hold against an untrusted model.** With `classifyAndMap`
  (`src/pipeline/mapper.ts`, unmodified) driven by a mocked `AnthropicModel`:
  - a hallucinated mapper quote (not a substring of the item) is discarded, the item is retried
    once, then downgraded to `needs_attorney`/`V-quote-not-found` on the second miss;
  - an unknown `rule_id` from the model is downgraded to `needs_attorney`/`N-unmapped`;
  - the explicit trap rules run **before** the model is ever asked to map, so a SAFE-closing email
    a model would happily call an award never reaches `model.map()` at all (asserted via
    `doGenerateCalls.length === 1`, i.e. only `classify()` ran) — the trap set is what keeps the
    untrusted model honest, exactly as constraint 4 requires.
- **`AnthropicCommandParser` request shape and output.** With `@ai-sdk/anthropic`'s `createAnthropic`
  mocked to a fixed `LanguageModelV4`, `parse()` returns commands that validate against the exact
  `CommandSchema` the text channel uses.
- **Rendered prompts.** `classifier`, `mapper` and `corroborator` (via `renderPrompt`) contain no
  identity-number field names, state that item text is data the model must never follow
  instructions from, state the model never judges visa eligibility, restrict the corroborator to
  primary/verifier sources only (never aggregators), and require the figure's number to be the
  first number in an exact, verbatim sentence. `check-rules` (`validateGraph`) still returns `[]`.

## What is NOT verified until a key exists

- **Real model behavior.** Whether Claude Sonnet 5 actually classifies and maps Dara Voss's corpus
  correctly, whether its quotes are exact substrings in practice (not just when a mock is told to
  produce one), and its real hallucination rate.
- **Real server-tool behavior.** Whether `web_search_20260209`/`web_fetch_20260209` are enabled for
  the Anthropic org, actual search result quality/domain-filtering behavior, real error codes and
  their frequency, and real latency/timeout behavior under the 30s/60s budgets chosen here.
- **Prompt caching, token cost, and rate limits** — nothing in this build exercises billing.
- **The Vercel AI SDK's actual wire format against the live Anthropic API** (as opposed to a mocked
  `LanguageModelV4`) — a real `@ai-sdk/anthropic` response could shape `content` differently than
  the hand-built mock results here, though the SDK's own type contracts are what both the mock and
  the real provider satisfy.
- **`AnthropicCommandParser`'s real command-extraction accuracy** against the injection/ambiguous
  texts in PRD 9 (E50–E56) — the mocked test only proves the request/response plumbing, not real
  judgment.

## First live check to run when a key exists

A 3-item smoke test, run manually (not in CI, to avoid spending a key on every push):

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npx tsx -e "
import { AnthropicModel } from './src/models/anthropic.ts';
import { loadGraph, renderPrompt } from './src/rules/graph.ts';
import { redacted } from './test/helpers.ts';

const graph = loadGraph();
const model = new AnthropicModel(process.env.ANTHROPIC_API_KEY!, { graph });

const items = [
  // 1. Expect: is_candidate true, kind 'award'; map() -> criteria [1], status 'qualifying', rule_id 'C1-award-competitive'.
  redacted({ app: 'gmail', id: 'smoke-1', title: 'Congratulations!', text: 'You won the Build Night grand prize, judged by a panel of 5 from 120 entrants.' }),
  // 2. Expect: is_candidate true, kind 'award' (classifier only sees keywords); explicit rules
  //    intercept before map() and force criteria [8], rule_id 'D-funding-remuneration' — never [1].
  redacted({ app: 'gmail', id: 'smoke-2', title: 'Your SAFE financing has closed', text: 'The SAFE (simple agreement for future equity) for Loomwork has closed with \$750,000 from 6 investors.' }),
  // 3. Expect: is_candidate false (newsletter, no evidence keywords).
  redacted({ app: 'gmail', id: 'smoke-3', title: 'This week in developer tools', text: 'Your weekly digest of top stories. Unsubscribe anytime.' }),
];

for (const item of items) {
  const cls = await model.classify(item, renderPrompt(graph, 'classifier'));
  console.log(item.id, 'classify ->', cls.output);
  if (cls.output.is_candidate) {
    const map = await model.map(item, { ...cls.output, decided_by: 'model' }, renderPrompt(graph, 'mapper'));
    console.log(item.id, 'map ->', map.output);
  }
}
"
```

Expected mappings are in the comments above each item. If item 2's `map()` output ever shows
criteria `[1]` for a model call, that is fine — the trap set in `classifyAndMap` is what actually
protects the pipeline (`applyExplicitRules` never calls `model.map()` for a SAFE-closing email at
all), not the prompt. The smoke test's job is to confirm the classifier/mapper *run* and produce
schema-valid output against the real API; `test/llm-path.test.ts` and `test/rules.test.ts` already
prove the safeguards.

For the Corroborator, a similar one-exhibit smoke test against a real outlet domain (e.g.
`techcrunch.com`) with `allowed_domains` restricted to it plus `auditedmedia.com` is the equivalent
first check, confirming `web_search`/`web_fetch` are enabled for the org and that a real
`web_search_tool_result`/`web_fetch_tool_result` shape matches what `AnthropicResearcher` parses.
