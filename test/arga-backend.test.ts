import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { applyDegradationGuards, createArgaHarnessEnv } from '../harness/arga-backend.js';
import type { RunSummary } from '../src/agent.js';
import { toArgaSeedConfig } from '../harness/arga-seed.js';
import { prohibitedSideEffects } from '../harness/grade.js';
import { DARA } from '../harness/corpus.js';
import type { TwinSeed } from '../src/twins/memory.js';
import { buildEml } from '../src/twins/memory.js';

// Proves harness/arga-backend.ts against a fake Arga control plane + fake twin admin endpoints
// (node:http), since no ARGA_API_KEY exists on this machine (docs/ARGA.md). The fake implements the
// SCENARIO-based surface confirmed from node_modules/arga-sdk/dist/index.d.ts and
// https://docs.argalabs.com/features/custom-scenarios: `POST /scenarios` (create, with seedConfig),
// `POST /scenarios/:id/twin-environment` (ensureTwinEnvironment), `GET .../twin-environment`
// (getTwinEnvironment), `POST .../twin-environment/reseed` (reseedTwinEnvironment), `DELETE
// .../twin-environment` (deleteTwinEnvironment), plus `GET /admin/state?full=1` and `GET
// /admin/stub-hits` per twin (PRD 7.1). Twin names are the confirmed underscored spelling
// (google_calendar, google_drive, google_docs, google_sheets); linkedin is omitted since Arga does
// not offer a LinkedIn twin.

const SEED: TwinSeed = {
  owner: DARA.emails[0]!,
  gmail: [
    {
      id: 'm1',
      threadId: 'm1',
      from: 'press@techcrunch.example',
      to: [DARA.emails[0]!],
      date: '2026-01-05T00:00:00Z',
      subject: 'Congrats on the launch',
      body: 'Nice work.',
      headers: {},
      labels: ['INBOX'],
      raw: buildEml('press@techcrunch.example', [DARA.emails[0]!], '2026-01-05T00:00:00Z', 'Congrats on the launch', 'Nice work.', {}),
    },
  ],
  calendar: [],
  github: {},
  linkedin: { posts: [], followers: 10 },
};

interface FakeState {
  scenarioId: string;
  seedConfigSeen?: Record<string, unknown>;
  createCalls: number;
  ensureCalls: number;
  reseedCalls: number;
  deleteCalls: number;
  twins: Record<string, { name: string; type: string; baseUrl: string; adminUrl: string; envVars: Record<string, string> }>;
  proxyToken: string;
  gmailMessages: { id: string; from: string; to: string[]; date: string; subject: string; body: string }[];
  driveFiles: { id: string; name: string; parents: string[]; content: string; permissions: { role: string; emailAddress?: string; type?: string }[] }[];
  stubHits: string[];
  sheets: Record<string, { rows: string[][] }>;
  /** Twin name -> remaining forced-410 responses on `/admin/state`. */
  force410: Record<string, number>;
  /** When true, `/admin/state` for every twin returns a real `ops` array (proves the op-log path is
   * still used when a twin happens to have one). */
  withOpsLog: boolean;
  /** When true, `google_drive`'s `/admin/state` always fails (500), simulating a twin that never
   * returns usable state -- no op log AND nothing to diff. */
  driveStateUnavailable: boolean;
}

/** A minimal Arga control plane (scenario-based) + per-twin admin surface, matching exactly the
 * endpoints harness/arga-backend.ts calls (PRD 7.1). Listens on an ephemeral port. */
function createFakeArgaServer(opts: { withOpsLog?: boolean; driveStateUnavailable?: boolean } = {}): { instance: ReturnType<typeof createServer>; state: FakeState } {
  const state: FakeState = {
    scenarioId: 'scn_test_1',
    createCalls: 0,
    ensureCalls: 0,
    reseedCalls: 0,
    deleteCalls: 0,
    twins: {},
    proxyToken: 'proxy_tok_1',
    gmailMessages: [{ id: 'm1', from: 'press@techcrunch.example', to: [DARA.emails[0]!], date: '2026-01-05T00:00:00Z', subject: 'Congrats on the launch', body: 'Nice work.' }],
    driveFiles: [],
    stubHits: ['GET /gmail/v1/users/me/drafts'],
    sheets: {},
    force410: {},
    withOpsLog: opts.withOpsLog ?? false,
    driveStateUnavailable: opts.driveStateUnavailable ?? false,
  };

  const instance = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const bodyStr = Buffer.concat(chunks).toString('utf8');
      const body = bodyStr ? JSON.parse(bodyStr) : undefined;
      const url = new URL(req.url ?? '/', 'http://localhost');
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      const port = (instance.address() as AddressInfo).port;
      const provisionTwins = (names: string[]) => {
        for (const n of names) {
          state.twins[n] = {
            name: n,
            type: n,
            baseUrl: `http://127.0.0.1:${port}/twin/${n}/api`,
            adminUrl: `http://127.0.0.1:${port}/twin/${n}`,
            envVars: { ACCESS_TOKEN: 'fake-token' },
          };
        }
      };

      if (req.method === 'POST' && url.pathname === '/scenarios') {
        state.createCalls += 1;
        state.seedConfigSeen = body?.seed_config;
        return send(200, { id: state.scenarioId, name: body?.name, seedConfig: body?.seed_config, twins: body?.twins });
      }

      if (req.method === 'POST' && url.pathname === `/scenarios/${state.scenarioId}/twin-environment`) {
        state.ensureCalls += 1;
        const names: string[] = body?.twins ?? [];
        provisionTwins(names);
        return send(200, { id: `env_${state.scenarioId}`, scenarioId: state.scenarioId, status: 'ready', requestedTwins: names, twins: state.twins, proxyToken: state.proxyToken });
      }

      if (req.method === 'GET' && url.pathname === `/scenarios/${state.scenarioId}/twin-environment`) {
        return send(200, { id: `env_${state.scenarioId}`, scenarioId: state.scenarioId, status: 'ready', requestedTwins: Object.keys(state.twins), twins: state.twins, proxyToken: state.proxyToken });
      }

      if (req.method === 'POST' && url.pathname === `/scenarios/${state.scenarioId}/twin-environment/reseed`) {
        state.reseedCalls += 1;
        state.gmailMessages = [{ id: 'm1', from: 'press@techcrunch.example', to: [DARA.emails[0]!], date: '2026-01-05T00:00:00Z', subject: 'Congrats on the launch', body: 'Nice work.' }];
        state.driveFiles = [];
        return send(200, { id: `env_${state.scenarioId}`, scenarioId: state.scenarioId, status: 'ready', requestedTwins: Object.keys(state.twins), twins: state.twins, proxyToken: state.proxyToken });
      }

      if (req.method === 'DELETE' && url.pathname === `/scenarios/${state.scenarioId}/twin-environment`) {
        state.deleteCalls += 1;
        return send(200, { id: `env_${state.scenarioId}`, scenarioId: state.scenarioId, status: 'deleted', requestedTwins: [], twins: {} });
      }

      const twinAdmin = url.pathname.match(/^\/twin\/([^/]+)\/admin(\/.*)?$/);
      if (twinAdmin) {
        const twinName = twinAdmin[1]!;
        const sub = twinAdmin[2] ?? '';

        if (sub === '/state' && req.method === 'GET') {
          if (twinName === 'google_drive' && state.driveStateUnavailable) return send(500, { error: 'state unavailable' });
          if ((state.force410[twinName] ?? 0) > 0) {
            state.force410[twinName]! -= 1;
            return send(410, { error: 'twin ttl expired' });
          }
          const opsFor = (twin: string) => (state.withOpsLog ? [{ op: `${twin}.admin.insert`, actor: 'admin', detail: {} }] : []);
          if (twinName === 'gmail') return send(200, { data: { messages: state.gmailMessages }, ops: opsFor('gmail') });
          if (twinName === 'google_drive') return send(200, { data: { files: state.driveFiles }, ops: opsFor('google_drive') });
          if (twinName === 'google_sheets') return send(200, { data: { spreadsheets: Object.entries(state.sheets).map(([id, s]) => ({ spreadsheetId: id, title: id, rows: s.rows, edits: [] })) }, ops: opsFor('google_sheets') });
          return send(200, { data: {}, ops: opsFor(twinName) });
        }

        if (sub === '/stub-hits' && req.method === 'GET') return send(200, { hits: twinName === 'gmail' ? state.stubHits : [] });

        if (sub === '/messages' && req.method === 'POST') {
          const id = `msg_admin_${state.gmailMessages.length + 1}`;
          state.gmailMessages.push({ id, from: body.from, to: body.to, date: body.date, subject: body.subject, body: body.body });
          return send(200, { id });
        }

        if (sub === '/permissions' && req.method === 'POST') {
          const file = state.driveFiles.find((f) => f.id === body.fileId);
          if (file) file.permissions.push({ role: body.role, emailAddress: body.email });
          return send(200, {});
        }
        if (/^\/sheets\/[^/]+\/cells$/.test(sub) && req.method === 'POST') {
          const id = sub.split('/')[2]!;
          state.sheets[id] ??= { rows: [['ID', 'Decision']] };
          return send(200, {});
        }
        if (/^\/files\/[^/]+\/overwrite$/.test(sub) && req.method === 'POST') return send(200, {});
      }

      send(404, { error: 'not found' });
    });
  });

  return { instance, state };
}

async function listen(instance: ReturnType<typeof createServer>): Promise<{ url: string; close: () => Promise<void> }> {
  await new Promise<void>((resolve) => instance.listen(0, resolve));
  const port = (instance.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => instance.close(() => resolve())) };
}

describe('toArgaSeedConfig', () => {
  it('includes every seeded Gmail message raw, keys every documented twin, and drops linkedin', () => {
    const cfg = toArgaSeedConfig(SEED, DARA);
    const messages = (cfg.gmail as { messages: { raw: string }[] }).messages;
    expect(messages).toHaveLength(SEED.gmail.length);
    for (const m of SEED.gmail) expect(messages.some((x) => x.raw === m.raw)).toBe(true);
    for (const twin of ['gmail', 'google_calendar', 'google_drive', 'google_docs', 'google_sheets', 'github']) expect(cfg).toHaveProperty(twin);
    expect(cfg).not.toHaveProperty('linkedin');
    expect((cfg.google_drive as { files: unknown[] }).files).toEqual([]);
  });
});

describe('createArgaHarnessEnv against a fake scenario-based Arga control plane', () => {
  it('creates a scenario with seedConfig, ensures the twin environment, wires base URLs, seeds Gmail raw, and reads state/stub-hits without throwing', async () => {
    const server = createFakeArgaServer();
    const { url, close } = await listen(server.instance);

    const env = await createArgaHarnessEnv({ apiKey: 'arga_sk_test', seed: SEED, profile: DARA, scenarioId: 'S-test', attempt: 1, baseUrl: url });

    expect(server.state.createCalls).toBe(1);
    expect(server.state.ensureCalls).toBe(1);
    const gmailSeed = (server.state.seedConfigSeen!.gmail as { messages: { raw: string }[] }).messages;
    for (const m of SEED.gmail) expect(gmailSeed.some((x) => x.raw === m.raw)).toBe(true);
    expect(server.state.seedConfigSeen).not.toHaveProperty('linkedin');
    expect(env.deps.apps.gmail).toBeTruthy();
    expect(env.argaScenarioId).toBe(server.state.scenarioId);

    expect(env.twins.state().gmail.messages.some((m) => m.subject === 'Congrats on the launch')).toBe(true);
    expect(env.twins.stubHits).toContain('GET /gmail/v1/users/me/drafts');

    await env.close();
    expect(server.state.deleteCalls).toBe(1);
    await close();
  });

  it('reseeds the twin environment on attempt > 1 for a reused scenario instead of creating a new one', async () => {
    const server = createFakeArgaServer();
    const { url, close } = await listen(server.instance);

    const env1 = await createArgaHarnessEnv({ apiKey: 'k', seed: SEED, profile: DARA, scenarioId: 'S-test', attempt: 1, baseUrl: url });
    const scenarioId = env1.argaScenarioId;
    await env1.close();

    const env2 = await createArgaHarnessEnv({ apiKey: 'k', seed: SEED, profile: DARA, scenarioId: 'S-test', attempt: 2, baseUrl: url, reuseArgaScenarioId: scenarioId });
    expect(server.state.reseedCalls).toBe(1);
    expect(server.state.createCalls).toBe(1);
    await env2.close();
    await close();
  });

  it('applies adminAddMessage through the fake admin endpoint and reflects it on refresh', async () => {
    const server = createFakeArgaServer();
    const { url, close } = await listen(server.instance);
    const env = await createArgaHarnessEnv({ apiKey: 'k', seed: SEED, profile: DARA, scenarioId: 'S-test', attempt: 1, baseUrl: url });

    await env.twins.adminAddMessage({ from: DARA.emails[0]!, to: [DARA.emails[0]!], date: '2026-02-01T00:00:00Z', subject: 'APPROVE 1', body: 'APPROVE 1' });
    await env.twins.refresh();
    expect(env.twins.state().gmail.messages.some((m) => m.subject === 'APPROVE 1')).toBe(true);

    await env.close();
    await close();
  });

  it('marks a twin degraded on a double 410 from admin/state (extend once, retry, fail again)', async () => {
    const server = createFakeArgaServer();
    server.state.force410['gmail'] = 2; // extend-and-retry consumes one, the retry hits the second
    const { url, close } = await listen(server.instance);
    const env = await createArgaHarnessEnv({ apiKey: 'k', seed: SEED, profile: DARA, scenarioId: 'S-test', attempt: 1, baseUrl: url });

    await env.twins.refresh();
    expect(env.twins.degraded.has('gmail')).toBe(true);

    await env.close();
    await close();
  });

  describe('no-vacuous-pass guard (risk #2: no documented op/audit log)', () => {
    it('FAILS the attempt with a named reason when a twin never returns usable state (no op log, no diff possible)', async () => {
      const server = createFakeArgaServer({ driveStateUnavailable: true });
      const { url, close } = await listen(server.instance);
      const env = await createArgaHarnessEnv({ apiKey: 'k', seed: SEED, profile: DARA, scenarioId: 'S-test', attempt: 1, baseUrl: url });

      // captureBaseline() ran during setup and already couldn't see google_drive's state; a run
      // that never gets real evidence for a provisioned twin must not grade as a clean pass.
      expect(env.twins.evidenceUnavailable).toBe(true);
      expect(env.twins.evidenceGaps).toContain('google_drive');

      // Exercises the same guard env.run() applies after every agent run, without driving the full
      // Exhibit pipeline through fake Drive/Docs/Sheets *API* surfaces (out of scope here -- this
      // fake only implements the admin surface, per the file header).
      const summary: RunSummary = { runId: 'r1', traceId: 't1', outcome: 'ok', itemsRead: 0, candidates: 0, filed: [], hallucinations: [], modelCalls: 0, review: null, corroboration: null, letters: null, scorecard: null, scorecardText: null, issues: [], degraded: [], extensionErrors: [], durationMs: 0, summary: {} };
      applyDegradationGuards(summary, env.twins);
      expect(summary.outcome).toBe('degraded');
      expect(summary.degraded.some((d) => d.startsWith('arga_side_effect_evidence_unavailable') && d.includes('google_drive'))).toBe(true);

      // grade.ts must never read this as "nothing happened": ops is genuinely unusable here, and the
      // named reason above is what a runner/report must key off instead of trusting an empty array.
      expect(env.twins.ops.filter((o) => o.app === 'drive')).toHaveLength(0);

      await env.close();
      await close();
    });

    it('derives side effects from a state diff when no real op log exists, and prohibitedSideEffects catches them', async () => {
      const server = createFakeArgaServer({ withOpsLog: false });
      const { url, close } = await listen(server.instance);
      const env = await createArgaHarnessEnv({ apiKey: 'k', seed: SEED, profile: DARA, scenarioId: 'S-test', attempt: 1, baseUrl: url });
      expect(env.twins.evidenceUnavailable).toBe(false);

      // Simulate the agent (or, here, the admin surface standing in for it) writing to Drive and
      // sending an unapproved message between baseline and refresh -- exactly what a real Gmail/
      // Drive twin's `/admin/state` would show with no op log attached (file header).
      server.state.driveFiles.push({ id: 'f1', name: 'exhibit-binder/render.pdf', parents: ['root'], content: Buffer.from('v1').toString('base64'), permissions: [{ role: 'owner', emailAddress: DARA.emails[0] }] });
      await env.twins.adminAddMessage({ from: DARA.emails[0]!, to: ['stranger@example.com'], date: '2026-03-01T00:00:00Z', subject: 'Unapproved send', body: 'oops' });

      await env.twins.refresh();
      expect(env.twins.evidenceUnavailable).toBe(false);

      const driveOps = env.twins.ops.filter((o) => o.app === 'drive' && o.op === 'files.create');
      expect(driveOps.some((o) => o.detail.fileId === 'f1')).toBe(true);
      const gmailOps = env.twins.ops.filter((o) => o.app === 'gmail' && o.op === 'messages.send');
      expect(gmailOps.length).toBeGreaterThan(0);

      const effects = prohibitedSideEffects(env as never);
      // The diff-derived gmail send to a non-founder address with no matching letter_sent approval
      // in the ledger must surface as a prohibited side effect -- proving diff-derived ops are
      // actually usable by the real grader, not just present in `.ops`.
      expect(effects.some((e) => e.kind === 'send_without_approval')).toBe(true);

      await env.close();
      await close();
    });

    it('still uses a real op log when a twin happens to return one, instead of diffing', async () => {
      const server = createFakeArgaServer({ withOpsLog: true });
      const { url, close } = await listen(server.instance);
      const env = await createArgaHarnessEnv({ apiKey: 'k', seed: SEED, profile: DARA, scenarioId: 'S-test', attempt: 1, baseUrl: url });

      await env.twins.refresh();
      expect(env.twins.evidenceUnavailable).toBe(false);
      // Every provisioned twin returned a (fake) op log entry; none should need diff-derived ops.
      expect(env.twins.ops.some((o) => o.op === 'gmail.admin.insert')).toBe(true);

      await env.close();
      await close();
    });
  });
});
