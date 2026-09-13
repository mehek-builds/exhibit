#!/usr/bin/env -S npx tsx
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { EXPLICIT_RULE_IDS } from './rules/explicit.js';
import { affected, allRuleIds, changedFragmentsSince, fragmentHash, loadGraph, unprovenFragments, validateGraph, writeProofs } from './rules/graph.js';
import type { PromptGraph } from './rules/graph.js';
import { currentRelease } from './release.js';
import { generateBrief } from './brief.js';
import type { MutationResult } from './brief.js';
import { runDemo } from './demo.js';
import { assertNotBothModes, durationMilliseconds, intervalMilliseconds, portNumber, positiveSafeInteger } from './cli-validation.js';

// Exhibit CLI (PRD section 13 brief skeleton, section 14 demo). Entry point
// for `npx tsx src/cli.ts <command>`; bin/exhibit.mjs spawns tsx on this file.

const REPORTS_DIR = join(process.cwd(), 'reports');
const LIFTED_DIR = join(process.cwd(), 'harness', 'lifted');

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch (err) {
    text = JSON.stringify({ error: `failed to stringify: ${String(err)}` }, null, 2);
  }
  writeFileSync(path, `${text}\n`);
}

function readJson<T>(path: string): T | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : null;
}

// ---------------- eval ----------------

async function cmdEval(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      core: { type: 'boolean', default: false },
      scenario: { type: 'string' },
      attempts: { type: 'string', default: '3' },
      gate: { type: 'string', default: 'mcp' },
      backend: { type: 'string', default: 'memory' },
    },
  });
  const { listScenarios, runMatrix } = await import('../harness/runner.js');
  const scenarios = values.scenario ? values.scenario.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  if (values.scenario !== undefined && (!scenarios || scenarios.length === 0)) {
    fail('--scenario must name at least one scenario, such as S1 or S1,S2.');
  }
  const attempts = positiveSafeInteger(values.attempts!, '--attempts');
  const gate = values.gate;
  if (gate !== 'mcp' && gate !== 'library') fail(`Unknown --gate '${gate}'; expected 'mcp' or 'library'.`);
  if (scenarios) {
    const known = new Set(listScenarios().map((scenario) => scenario.id));
    const unknown = scenarios.filter((scenario) => !known.has(scenario));
    if (unknown.length) fail(`Unknown --scenario value(s): ${unknown.join(', ')}.`);
  }
  const release = currentRelease();
  const backend = values.backend as 'memory' | 'arga';
  if (backend !== 'memory' && backend !== 'arga') fail(`Unknown --backend '${values.backend}'; expected 'memory' or 'arga'.`);
  const argaApiKey = process.env.ARGA_API_KEY;
  if (backend === 'arga' && !argaApiKey) {
    fail("--backend arga requires ARGA_API_KEY to be set in the environment. Refusing to start: this backend never silently falls back to memory.");
  }
  console.log(`Running eval: backend=${backend}, ${scenarios ? scenarios.join(', ') : values.core ? 'core scenarios' : 'all scenarios'}, attempts=${attempts}, gate=${gate}, release=${release}`);
  const result = await runMatrix({
    scenarios,
    core: values.core,
    attempts,
    gate,
    release,
    backend,
    argaApiKey,
    argaBaseUrl: process.env.ARGA_BASE_URL || undefined, // `ARGA_BASE_URL=` in .env means unset
    onAttempt: (r: import('../harness/runner.js').AttemptResult) => {
      console.log(`  [${r.scenarioId}] attempt ${r.attempt}: ${r.passed ? 'PASS' : 'FAIL'} (${r.checks.filter((c: { pass: boolean }) => c.pass).length}/${r.checks.length} checks, ${r.sideEffects.length} side effect(s), ${(r.durationMs / 1000).toFixed(1)}s)`);
    },
  });

  console.log('');
  console.log('Scenario | Title | Attempts | Passed | Side effects');
  for (const s of result.stats) {
    console.log(`${s.scenarioId} | ${s.title} | ${s.attempts} | ${s.passed}/${s.attempts} | ${s.sideEffects}`);
  }
  console.log('');
  console.log(`All core scenarios passed: ${result.allCorePassed}`);

  mkdirSync(REPORTS_DIR, { recursive: true });
  writeJson(join(REPORTS_DIR, 'eval-latest.json'), result);
  writeJson(join(REPORTS_DIR, `eval-${result.batchId}.json`), result);
  console.log(`Wrote reports/eval-latest.json and reports/eval-${result.batchId}.json`);

  const allSelectedPassed = result.attempts.length > 0 && result.attempts.every((a) => a.passed);
  console.log(`All selected attempts passed: ${allSelectedPassed} (${result.attempts.filter((a) => a.passed).length}/${result.attempts.length})`);
  if (!allSelectedPassed) process.exit(1);
}

// ---------------- mutate ----------------

async function cmdMutate(): Promise<void> {
  const { mutationCheck } = await import('../harness/runner.js');
  const result = await mutationCheck();
  console.log('Mutation | Disabled rules | Scenario | Killed | Detail');
  for (const m of result.mutations) console.log(`${m.name} | ${m.disabled.join(', ')} | ${m.scenario} | ${m.killed ? 'yes' : 'NO (survived)'} | ${m.detail}`);
  writeJson(join(REPORTS_DIR, 'mutation-latest.json'), result);
  console.log('Wrote reports/mutation-latest.json');
  if (result.mutations.some((m: { killed: boolean }) => !m.killed)) process.exit(1);
}

// ---------------- brief ----------------

async function cmdBrief(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { out: { type: 'string', default: 'BRIEF.md' } } });
  const evalResult = readJson<import('../harness/runner.js').MatrixResult>(join(REPORTS_DIR, 'eval-latest.json'));
  if (!evalResult) fail('No reports/eval-latest.json found. Run `exhibit eval` first.');
  const mutation = readJson<MutationResult>(join(REPORTS_DIR, 'mutation-latest.json')) ?? undefined;
  const graph = loadGraph();
  const text = generateBrief({ eval: evalResult, mutation, graph });
  writeFileSync(values.out!, text);
  console.log(`Wrote ${values.out}`);
}

// ---------------- affected / check-rules / prove-rules ----------------

function printAffected(graph: PromptGraph, fragments: string[]): void {
  if (fragments.length === 0) {
    console.log('No fragments changed.');
    return;
  }
  const a = affected(graph, fragments);
  console.log(`Fragments: ${a.fragments.join(', ')}`);
  console.log(`Prompts affected: ${a.prompts.join(', ') || 'none'}`);
  console.log(`Scenarios to re-run: ${a.scenarios.join(', ') || 'none'}`);
  for (const [p, ss] of Object.entries(a.byPrompt)) console.log(`  ${p}: ${ss.join(', ') || 'none'}`);
}

async function cmdAffected(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { git: { type: 'string' } } });
  const graph = loadGraph();
  const fragments = values.git ? changedFragmentsSince(graph, values.git) : positionals;
  const unknown = fragments.filter((fragment) => !graph.fragments.has(fragment));
  if (unknown.length) fail(`Unknown fragment(s): ${unknown.join(', ')}.`);
  printAffected(graph, fragments);
}

function scanCodeRuleIds(): string[] {
  const ids = new Set<string>(EXPLICIT_RULE_IDS);
  const patterns = [/\brule_id:\s*'([\w-]+)'/g, /\bmapping\(\s*\[[^\]]*\]\s*,\s*'[\w]+'\s*,\s*'([\w-]+)'/g];
  const walk = (dir: string): string[] => {
    let out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) out = out.concat(walk(path));
      else if (entry.name.endsWith('.ts')) out.push(path);
    }
    return out;
  };
  for (const file of walk(join(process.cwd(), 'src'))) {
    const text = readFileSync(file, 'utf8');
    for (const re of patterns) for (const m of text.matchAll(re)) ids.add(m[1]!);
  }
  return [...ids].sort();
}

async function cmdCheckRules(): Promise<void> {
  const graph = loadGraph();
  const problems = validateGraph(graph);
  const known = new Set(allRuleIds(graph));
  const codeIds = scanCodeRuleIds();
  const missing = codeIds.filter((id) => !known.has(id));
  for (const id of missing) problems.push(`rule id '${id}' is used in code but not declared in any fragment`);

  console.log(`Graph fragments: ${graph.fragments.size}, prompts: ${graph.prompts.size}, edges: ${graph.edges.length}`);
  console.log(`Rule ids in code: ${codeIds.length}. Declared in fragments: ${known.size}.`);
  if (problems.length) {
    console.log('Problems:');
    for (const p of problems) console.log(`  - ${p}`);
  } else {
    console.log('No graph or rule-id problems found.');
  }
  const unproven = unprovenFragments(graph);
  console.log(`Unproven fragments (no matching prompts/proofs.json entry): ${unproven.length ? unproven.join(', ') : 'none'}`);

  if (problems.length || unproven.length) process.exit(1);
}

async function cmdProveRules(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { all: { type: 'boolean', default: false }, fragment: { type: 'string' }, description: { type: 'string' } },
  });
  const graph = loadGraph();
  const named = values.fragment ? values.fragment.split(',').map((f) => f.trim()).filter(Boolean) : null;
  for (const f of named ?? []) if (!graph.fragments.has(f)) fail(`Unknown fragment: ${f}`);
  const toProve = named ?? (values.all ? [...graph.fragments.keys()] : unprovenFragments(graph));
  if (toProve.length === 0) {
    console.log('Nothing to prove: every fragment already matches prompts/proofs.json.');
    return;
  }
  const a = affected(graph, toProve);
  console.log(`Proving fragments: ${toProve.join(', ')}`);
  console.log(`Scenarios: ${a.scenarios.join(', ') || 'none'}`);
  if (a.scenarios.length === 0) {
    fail('No scenarios exercise these fragments; nothing to re-run. Refusing to write proofs.');
  }
  const { runMatrix } = await import('../harness/runner.js');
  const release = currentRelease();
  const result = await runMatrix({ scenarios: a.scenarios, attempts: 3, release });
  const allPassed = result.stats.every((s: { passed: number; attempts: number }) => s.passed === s.attempts);
  for (const s of result.stats) console.log(`  ${s.scenarioId}: ${s.passed}/${s.attempts}`);
  if (!allPassed) {
    console.error('Not every scenario passed 3 of 3; proofs not written.');
    process.exit(1);
  }
  const scenarios: Record<string, { attempts: number; passed: number }> = {};
  for (const s of result.stats) scenarios[s.scenarioId] = { attempts: s.attempts, passed: s.passed };
  const fragments: Record<string, string> = {};
  for (const [name, f] of graph.fragments) fragments[name] = fragmentHash(f);
  writeProofs(graph, { release, at: new Date().toISOString(), fragments, scenarios });
  console.log(`Wrote ${join('prompts', 'proofs.json')}.`);
  // A named or changed fragment is a rule change worth a row in the durable log (brief section 8);
  // a blanket --all re-proof is a baseline, not a change.
  if (named || !values.all) {
    const { recordRuleChange, ruleChangeFromProof } = await import('./loop/ruleChanges.js');
    const description = values.description ?? `Re-proved ${toProve.join(', ')}`;
    for (const frag of toProve) recordRuleChange(ruleChangeFromProof(graph, [frag], result, { description }));
    console.log(`Recorded ${toProve.length} rule change(s) in ${join('prompts', 'rule-changes.json')}.`);
  }
}

// ---------------- demo ----------------

async function cmdDemo(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { out: { type: 'string', default: 'out/demo' } } });
  await runDemo(values.out!);
}

// ---------------- arga-demo ----------------

/** Seeds Dara Voss's full synthetic year into hosted Arga twins, runs Exhibit once against them,
 * and leaves the environment up so the inbox and the filed binder can be browsed in Arga's own
 * Gmail and Drive twin UIs during the demo. Rerunning reseeds the same environment. */
async function cmdArgaDemo(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { teardown: { type: 'boolean', default: false }, scenario: { type: 'string', default: 'S1' } } });
  const apiKey = process.env.ARGA_API_KEY;
  if (!apiKey) fail('arga-demo requires ARGA_API_KEY in the environment.');
  const { Arga } = await import('arga-sdk');
  const { ARGA_API_BASE_URL } = await import('../harness/arga.js');
  const { createArgaHarnessEnv } = await import('../harness/arga-backend.js');
  const baseUrl = process.env.ARGA_BASE_URL || ARGA_API_BASE_URL;
  const scenarioName = 'exhibit-demo';

  if (values.teardown) {
    const client = new Arga({ apiKey, baseUrl });
    const existing = (await client.scenarios.list()).find((s) => s.name === scenarioName);
    if (!existing) return console.log(`No ${scenarioName} scenario found.`);
    await client.scenarios.deleteTwinEnvironment(existing.id);
    console.log(`Tore down the ${scenarioName} twin environment.`);
    return;
  }

  const { loadScenarios } = await import('../harness/scenarios.js').then((m) => ({ loadScenarios: m.scenarios }));
  const { DARA } = await import('../harness/corpus.js');
  const { prohibitedSideEffects } = await import('../harness/grade.js');
  const s = loadScenarios().find((x) => x.id === values.scenario);
  if (!s) fail(`Unknown scenario '${values.scenario}'.`);
  const seed = s.seed();
  console.log(`Seeding ${seed.gmail.length} emails and ${seed.calendar.length} calendar events for ${(s.profile ?? DARA).name} into Arga twins (${s.id}: ${s.title})...`);
  const env = await createArgaHarnessEnv({ apiKey, baseUrl, seed, profile: s.profile ?? DARA, scenarioId: `arga-demo-${s.id}`, attempt: 1, gate: 'mcp', scenarioName, keepEnvironment: true });
  try {
    const summary = await env.run();
    const effects = prohibitedSideEffects(env as unknown as Parameters<typeof prohibitedSideEffects>[0]);
    const card = summary.scorecard;
    console.log(`\nRun ${summary.outcome}: read ${summary.itemsRead} items, ${summary.candidates} candidates, filed ${summary.filed.length} exhibits.`);
    if (card) console.log(`O-1A: ${card.o1Met} of 8 criteria met. EB-1A: ${card.eb1Met} of 10.`);
    if (summary.degraded.length > 0) console.log(`Degraded: ${summary.degraded.join(', ')}`);
    console.log(`Prohibited side effects in the twins: ${effects.length}${effects.length ? ` (${effects.map((e) => e.kind).join(', ')})` : ''}`);
    console.log(`\nArga environment left running (rerun to reseed, --teardown to remove):`);
    if (env.dashboardUrl) console.log(`  dashboard: ${env.dashboardUrl}`);
    for (const [name, url] of Object.entries(env.twinUrls)) console.log(`  ${name}: ${url}`);
  } finally {
    await env.close();
  }
}

// ---------------- lift ----------------

function nextLiftedId(): number {
  if (!existsSync(LIFTED_DIR)) return 19;
  let max = 18;
  for (const f of readdirSync(LIFTED_DIR)) {
    const m = /^S(\d+)\.json$/.exec(f);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

async function cmdLift(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      issue: { type: 'string' },
      gmail: { type: 'string' },
      'expect-status': { type: 'string' },
      criteria: { type: 'string' },
      never: { type: 'string' },
      title: { type: 'string' },
    },
  });
  if (!values.issue || !values.gmail || !values['expect-status']) fail('Usage: exhibit lift --issue <text> --gmail <path-to-json-message> --expect-status <status> [--criteria 3,4] [--never 1] [--title ...]');
  const gmailMsg = readJson<{ id: string; from: string; to?: string[]; date: string; subject: string; body: string }>(values.gmail!);
  if (!gmailMsg) fail(`Could not read gmail message from ${values.gmail}`);
  const n = nextLiftedId();
  const id = `S${n}`;
  const record = {
    id,
    title: values.title ?? `Lifted from ${values.issue}`,
    sourceIssue: values.issue,
    createdAt: new Date().toISOString(),
    gmail: [gmailMsg],
    expect: {
      source: `gmail:${gmailMsg!.id}`,
      status: values['expect-status'],
      ...(values.criteria ? { criteria: values.criteria.split(',').map(Number) } : {}),
      ...(values.never ? { never: values.never.split(',').map(Number) } : {}),
    },
  };
  mkdirSync(LIFTED_DIR, { recursive: true });
  const path = join(LIFTED_DIR, `${id}.json`);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`Wrote ${path}`);
}

// ---------------- run / watch (live) ----------------

const LIVE_ENV_VARS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GITHUB_TOKEN', 'EXHIBIT_OWNER_EMAIL'];

function explainLiveEnv(): void {
  console.log('Live mode needs --live plus these env vars:');
  console.log(`  Required: ${LIVE_ENV_VARS.join(', ')}`);
  console.log('  Optional: ANTHROPIC_API_KEY (else the heuristic model),');
  console.log('            EXHIBIT_PROFILE (founder profile JSON string; required to run).');
}

const MOCK_BANNER = 'MOCK MODE: synthetic founder, in-memory apps, no network';

function defaultMockStateDir(): string {
  return join(process.cwd(), '.exhibit', 'mock');
}

function printMockRunSummary(summary: import('./agent.js').RunSummary): void {
  console.log(`Exhibits filed: ${summary.filed.length}${summary.filed.length ? ` (${summary.filed.join(', ')})` : ''}`);
  console.log(`Figures queued: ${summary.review?.pending?.length ?? 0}`);
  console.log(`Letters: ${summary.letters ? JSON.stringify(summary.letters) : 'none'}`);
  if (summary.scorecardText) {
    const o1 = summary.scorecardText.match(/O-1A: \d+ of 8[^\n]*/)?.[0];
    const eb1 = summary.scorecardText.match(/EB-1A: \d+ of 10[^\n]*/)?.[0];
    if (o1) console.log(o1);
    if (eb1) console.log(eb1);
  }
  console.log(`Outcome: ${summary.outcome}`);
}

async function cmdRun(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      live: { type: 'boolean', default: false },
      mock: { type: 'boolean', default: false },
      state: { type: 'string' },
      advance: { type: 'string' },
    },
  });
  try {
    assertNotBothModes(values);
  } catch (err) {
    fail((err as Error).message);
  }
  if (values.mock) {
    const { buildMockDeps } = await import('./mock/deps.js');
    const { runExhibit } = await import('./agent.js');
    console.log(MOCK_BANNER);
    const stateDir = values.state ?? defaultMockStateDir();
    const { deps, env, save, close } = await buildMockDeps({ stateDir });
    try {
      if (values.advance) {
        env.clock.advance(durationMilliseconds(values.advance, '--advance'));
      }
      const summary = await runExhibit(deps);
      printMockRunSummary(summary);
      await save();
      if (summary.outcome !== 'ok') process.exitCode = 1;
    } finally {
      await close();
    }
    return;
  }
  if (!values.live) {
    explainLiveEnv();
    fail('Refusing to run without --live or --mock (harness mode is `exhibit eval`).');
  }
  const missing = LIVE_ENV_VARS.filter((v) => !process.env[v]);
  if (missing.length || !process.env.EXHIBIT_PROFILE) {
    explainLiveEnv();
    fail(`Missing: ${[...missing, ...(process.env.EXHIBIT_PROFILE ? [] : ['EXHIBIT_PROFILE'])].join(', ')}`);
  }
  const { buildLiveDeps } = await import('./config.js');
  const { runExhibit } = await import('./agent.js');
  const { deps, close } = await buildLiveDeps(process.env);
  try {
    const summary = await runExhibit(deps);
    console.log(JSON.stringify(summary.summary, null, 2));
  } finally {
    await close();
  }
}

async function cmdWatch(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      live: { type: 'boolean', default: false },
      mock: { type: 'boolean', default: false },
      interval: { type: 'string', default: '300' },
      state: { type: 'string' },
      'advance-per-tick': { type: 'string' },
    },
  });
  try {
    assertNotBothModes(values);
  } catch (err) {
    fail((err as Error).message);
  }
  if (values.mock) {
    const intervalMs = intervalMilliseconds(values.interval!, '--interval');
    const advancePerTickMs = values['advance-per-tick'] ? durationMilliseconds(values['advance-per-tick'], '--advance-per-tick') : 0;
    const { buildMockDeps } = await import('./mock/deps.js');
    const { runExhibit } = await import('./agent.js');
    console.log(MOCK_BANNER);
    const stateDir = values.state ?? defaultMockStateDir();
    const { deps, env, save, close } = await buildMockDeps({ stateDir });
    let stopped = false;
    process.on('SIGINT', () => {
      stopped = true;
      console.log('Stopping after the current run, saving state...');
    });
    try {
      while (!stopped) {
        if (advancePerTickMs) env.clock.advance(advancePerTickMs);
        const summary = await runExhibit(deps);
        console.log(`${new Date().toISOString()} ${JSON.stringify(summary.summary)}`);
        await save();
        if (stopped) break;
        await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
      }
    } finally {
      await save();
      await close();
    }
    return;
  }
  const intervalMs = intervalMilliseconds(values.interval!, '--interval');
  if (!values.live) {
    explainLiveEnv();
    fail('Refusing to watch without --live or --mock.');
  }
  const missing = LIVE_ENV_VARS.filter((v) => !process.env[v]);
  if (missing.length || !process.env.EXHIBIT_PROFILE) {
    explainLiveEnv();
    fail(`Missing: ${[...missing, ...(process.env.EXHIBIT_PROFILE ? [] : ['EXHIBIT_PROFILE'])].join(', ')}`);
  }
  const { buildLiveDeps } = await import('./config.js');
  const { runExhibit } = await import('./agent.js');
  const { deps, close } = await buildLiveDeps(process.env);
  let stopped = false;
  process.on('SIGINT', () => {
    stopped = true;
    console.log('Stopping after the current run...');
  });
  try {
    while (!stopped) {
      const summary = await runExhibit(deps);
      console.log(`${new Date().toISOString()} ${JSON.stringify(summary.summary)}`);
      if (stopped) break;
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    }
  } finally {
    await close();
  }
}

// ---------------- text --mock ----------------

async function cmdText(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      mock: { type: 'boolean', default: false },
      port: { type: 'string' },
      from: { type: 'string' },
    },
  });
  if (!values.mock) fail('`exhibit text` currently only supports --mock (text your local `serve --mock`).');
  const message = positionals.join(' ');
  if (!message) fail('Usage: exhibit text --mock ["--port <n>"] ["--from <E.164>"] "<message>"');
  const port = portNumber(values.port ?? '8787');
  const { DARA } = await import('../harness/corpus.js');
  const founderPhone = DARA.phone ?? '';
  const from = values.from ?? founderPhone;
  if (from !== founderPhone) {
    console.log(`Ignored: ${from} is not the synthetic founder's verified number (${founderPhone}); per constraint 15, inbound texts from any other number are dropped.`);
  }
  const { twilioSignature } = await import('./server/webhook.js');
  const authToken = 'mock-twilio-auth-token';
  const url = `http://127.0.0.1:${port}/twilio`;
  const params: Record<string, string> = { From: from, To: 'whatsapp:+15550009999', Body: message, MessageSid: `SMmock${Date.now()}` };
  const signature = twilioSignature(url, params, authToken);
  const body = new URLSearchParams(params).toString();

  type OutboxMessage = { direction: string; to: string; from: string; body: string };
  const outboxUrl = `http://127.0.0.1:${port + 1}/mock/outbox`;
  const readOutbound = async (): Promise<OutboxMessage[] | null> => {
    const r = await fetch(outboxUrl).catch(() => null);
    if (!r || r.status !== 200) return null;
    const json = (await r.json()) as { messages: OutboxMessage[] };
    return json.messages.filter((m) => m.direction === 'outbound');
  };
  const before = (await readOutbound())?.length ?? 0;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature },
    body,
  });
  console.log(`POST ${url} -> ${res.status}`);
  await res.text().catch(() => '');
  if (from !== founderPhone) return;

  // The reply comes from the run serve --mock triggers on this text; wait for a new outbound message.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const outbound = await readOutbound();
    if (outbound === null) {
      console.log('(no /mock/outbox available: is `serve --mock` running on this port?)');
      process.exitCode = 1;
      return;
    }
    if (outbound.length > before) {
      console.log('Reply:');
      for (const r of outbound.slice(before)) console.log(`  ${r.from} -> ${r.to}: ${r.body}`);
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }
  console.log('(no reply within 20s)');
  process.exitCode = 1;
}

// ---------------- help ----------------

function cmdHelp(): void {
  console.log(`Exhibit CLI

  eval [--core] [--scenario S1,S2] [--attempts 1-100] [--gate mcp|library] [--backend memory|arga]
                                               --backend arga requires ARGA_API_KEY in the environment
  mutate
  brief [--out BRIEF.md]
  affected <fragment...> | affected --git <ref>
  check-rules
  prove-rules [--all]
  demo [--out out/demo]
  arga-demo [--scenario S1] [--teardown]      Seed a scenario into hosted Arga twins, run once, leave it browsable
  lift --issue <text> --gmail <path> --expect-status <status> [--criteria 3,4] [--never 1] [--title ...]
  run --live
  run --mock [--state <dir>] [--advance <1h|7d|...>]
  watch --live [--interval <seconds, min 60>]
  watch --mock [--state <dir>] [--interval <seconds, min 60>] [--advance-per-tick <dur>]
  serve [--interval <seconds, min 60>] [--port <n>]   Twilio webhook plus the scheduled run (live)
  serve --mock [--state <dir>] [--interval <seconds>] [--port <n>]
  text --mock ["--port <n>"] ["--from <E.164>"] "<message>"   Text your local serve --mock
  verify [--demo out/demo]                    Re-check a live binder or an exported synthetic demo
  verify --mock [--state <dir>]               Re-check the mock binder built by run/watch/serve --mock
  loop                                        Lifted-scenario loop status and detector labels from reports/eval-latest.json
  flow [--out out/flow] [--json]              Walk every PRD stage end to end on mock data; exit 1 if any stage fails
  help

  Run the whole flow on mock data (no live keys, no network):
    exhibit run --mock
    exhibit serve --mock
    exhibit text --mock "approve 1"
    exhibit run --mock --advance 7d
    exhibit verify --mock`);
}

/** Commands that return an exit code set it without cutting off pending output. */
function exitWith(code: unknown): void {
  if (typeof code === 'number' && code !== 0) process.exitCode = code;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'eval':
      return cmdEval(rest);
    case 'mutate':
      return cmdMutate();
    case 'brief':
      return cmdBrief(rest);
    case 'affected':
      return cmdAffected(rest);
    case 'check-rules':
      return cmdCheckRules();
    case 'prove-rules':
      return cmdProveRules(rest);
    case 'demo':
      return cmdDemo(rest);
    case 'arga-demo':
      return cmdArgaDemo(rest);
    case 'lift':
      return cmdLift(rest);
    case 'run':
      return cmdRun(rest);
    case 'watch':
      return cmdWatch(rest);
    case 'text':
      return cmdText(rest);
    case 'serve':
      return exitWith(await (await import('./commands/serve.js')).cmdServe(rest));
    case 'verify':
      return exitWith(await (await import('./commands/verify.js')).cmdVerify(rest));
    case 'loop':
      return exitWith(await (await import('./commands/loop.js')).cmdLoop(rest));
    case 'flow':
      return exitWith(await (await import('./commands/flow.js')).cmdFlow(rest));
    case 'help':
    case undefined:
      return cmdHelp();
    default:
      console.error(`Unknown command: ${command}`);
      cmdHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
