import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ArgaHarnessEnv } from '../harness/arga-backend.js';
import { ARGA_SCENARIO_NAME, applyDegradationGuards, createArgaHarnessEnv, stripTwinControlPlane } from '../harness/arga-backend.js';
import { gmailInsertBody, seedMessagesInOrder, toArgaSeedConfig } from '../harness/arga-seed.js';
import { DARA } from '../harness/corpus.js';
import { prohibitedSideEffects } from '../harness/grade.js';
import type { RunSummary } from '../src/agent.js';
import type { GmailMessage } from '../src/apps/types.js';
import type { TwinSeed } from '../src/twins/memory.js';
import { buildEml } from '../src/twins/memory.js';
import type { FakeArga } from './arga-fake.js';
import { PROXY_TOKEN, SHEET_MIME, installNetworkGuard, startFakeArga } from './arga-fake.js';

// Proves harness/arga-backend.ts and harness/arga-seed.ts against test/arga-fake.ts, a local
// stand-in for the Arga control plane and the five Google twins that reproduces what the real
// service did when probed (docs/ARGA.md): snake_case responses the SDK camelCases, one origin per
// twin, each twin accepting only its own env-var token (the proxy token gets a 401), Google API
// shapes for Gmail, Calendar, Drive (multipart uploads), Docs and Sheets, and 410 for a lapsed TTL.
// A network guard blocks every non-loopback request, so nothing here can reach a real host.

const OWNER = DARA.emails[0]!;
const KEY = 'arga_sk_test';

function mail(id: string, threadId: string, from: string, to: string[], date: string, subject: string, body: string, labels = ['INBOX']): GmailMessage {
  return { id, threadId, from, to, date, subject, body, headers: {}, labels, raw: buildEml(from, to, date, subject, body, {}) };
}

// Deliberately out of date order: the reply sits before the message it replies to.
const SEED: TwinSeed = {
  owner: OWNER,
  gmail: [
    mail('m-launch-reply', 't-launch', OWNER, ['press@techcrunch.example'], '2026-01-06T09:00:00Z', 'Re: Congrats on the launch', 'Thank you!', ['SENT']),
    mail('m-launch', 't-launch', 'press@techcrunch.example', [OWNER], '2026-01-05T00:00:00Z', 'Congrats on the launch', 'Nice work.'),
    mail('m-judge', 'm-judge', 'Marco Ellis <marco@hackmesa.example>', [OWNER], '2025-10-20T17:00:00Z', 'Invitation to judge HackMesa 2026', 'Would you judge?'),
  ],
  calendar: [
    {
      id: 'ev-demo-day',
      summary: 'Demo Day',
      description: 'Pitch on stage',
      start: '2026-02-10T17:00:00Z',
      end: '2026-02-10T18:00:00Z',
      status: 'confirmed',
      organizer: { email: 'events@accelerator.example' },
      attendees: [{ email: OWNER, responseStatus: 'accepted', self: true }],
      updated: '2026-01-01T00:00:00Z',
    },
  ],
  github: {},
  linkedin: { posts: [], followers: 10 },
};

function emptySummary(): RunSummary {
  return { runId: 'r1', traceId: 't1', outcome: 'ok', itemsRead: 0, candidates: 0, filed: [], hallucinations: [], modelCalls: 0, review: null, corroboration: null, letters: null, scorecard: null, scorecardText: null, issues: [], degraded: [], extensionErrors: [], durationMs: 0, summary: {} };
}

let guard: ReturnType<typeof installNetworkGuard>;
let fake: FakeArga;
const opened: ArgaHarnessEnv[] = [];

beforeAll(() => {
  guard = installNetworkGuard();
});
afterAll(() => guard.restore());
afterEach(async () => {
  for (const env of opened.splice(0)) await env.close();
  await fake?.close();
  // Nothing may have tried to leave the machine (an upload aimed at www.googleapis.com, a default
  // Arga host). The guard fails such a call immediately; this makes the test fail too.
  expect(guard.blocked).toEqual([]);
});

async function open(extra: Partial<Parameters<typeof createArgaHarnessEnv>[0]> = {}): Promise<ArgaHarnessEnv> {
  const env = await createArgaHarnessEnv({ apiKey: KEY, seed: SEED, profile: DARA, scenarioId: 'S-test', attempt: 1, baseUrl: fake.url, readyTimeoutMs: 2000, gate: 'library', ...extra });
  opened.push(env);
  return env;
}

describe('arga-seed', () => {
  it('toArgaSeedConfig is the skeleton only: an empty mailbox, one Primary calendar, an empty Drive', () => {
    const cfg = toArgaSeedConfig(SEED, DARA);
    expect(cfg).toEqual({
      gmail: { messages: [] },
      google_calendar: { calendars: [{ name: 'Primary', timezone: 'UTC', events: [] }] },
      google_drive: { files: [] },
    });
    // No seed content leaks into seed_config (a `raw` entry crashes Arga seeding with a 500).
    expect(JSON.stringify(cfg)).not.toContain('Congrats');
  });

  it('gmailInsertBody base64url-encodes the untouched raw and keeps labels and the twin thread id', () => {
    const m = SEED.gmail[0]!;
    const body = gmailInsertBody(m);
    expect(body.raw).not.toMatch(/[+/=]/);
    expect(Buffer.from(body.raw, 'base64url').toString('utf8')).toBe(m.raw);
    expect(body.labelIds).toEqual(['SENT']);
    expect(body).not.toHaveProperty('threadId');
    expect(gmailInsertBody(m, 'twin-thread-9').threadId).toBe('twin-thread-9');
    expect(gmailInsertBody({ ...m, labels: [] }).labelIds).toEqual(['INBOX']);
  });

  it('seedMessagesInOrder sorts oldest first without mutating the seed', () => {
    const before = SEED.gmail.map((m) => m.id);
    expect(seedMessagesInOrder(SEED).map((m) => m.id)).toEqual(['m-judge', 'm-launch', 'm-launch-reply']);
    expect(SEED.gmail.map((m) => m.id)).toEqual(before);
  });
});

describe('createArgaHarnessEnv against the fake Arga service', () => {
  it('creates the saved scenario with the skeleton, ensures all five twins, seeds through the APIs with each twin token, and reports seed ids', async () => {
    fake = await startFakeArga({ owner: OWNER });
    const env = await open();

    expect(fake.state.calls.create).toBe(1);
    expect(fake.state.scenarios[0]!.name).toBe(ARGA_SCENARIO_NAME);
    expect(fake.state.scenarios[0]!.seed_config).toEqual(toArgaSeedConfig(SEED, DARA));
    expect(fake.state.calls.ensure).toBe(1);
    expect(env.argaScenarioId).toBe(fake.state.scenarios[0]!.id);
    expect(Object.keys(env.twinUrls).sort()).toEqual(['gmail', 'google_calendar', 'google_docs', 'google_drive', 'google_sheets']);
    expect(env.twinUrls.gmail).toBe(fake.twinUrls.gmail);
    expect(env.dashboardUrl).toMatch(/environments\/env_/);

    // Every seed message and event went in through the twins' own APIs, and no request carried the
    // proxy token (the fake rejects it with a 401, like the real twins).
    expect(fake.state.requests.filter((r) => r.twin === 'gmail' && r.method === 'POST' && r.path === '/gmail/v1/users/me/messages')).toHaveLength(SEED.gmail.length);
    expect(fake.state.requests.filter((r) => r.twin === 'google_calendar' && r.method === 'POST')).toHaveLength(1);
    expect(fake.state.rejectedAuth).toEqual([]);
    const probe = await fetch(`${fake.twinUrls.gmail}/gmail/v1/users/me/messages`, { headers: { authorization: `Bearer ${PROXY_TOKEN}` } });
    expect(probe.status).toBe(401);

    // The twin assigned its own ids and kept the raw bytes; the reply went into the original's thread.
    const twinLaunch = fake.state.gmail.find((m) => m.raw === SEED.gmail[1]!.raw)!;
    const twinReply = fake.state.gmail.find((m) => m.raw === SEED.gmail[0]!.raw)!;
    expect(twinLaunch.id).not.toBe('m-launch');
    expect(twinReply.threadId).toBe(twinLaunch.threadId);
    expect(twinReply.labelIds).toEqual(['SENT']);

    // The grader's view and the agent's view both report seed ids and seed thread ids.
    const graded = env.twins.state().gmail.messages;
    expect(graded.map((m) => m.id).sort()).toEqual(['m-judge', 'm-launch', 'm-launch-reply']);
    expect(graded.find((m) => m.id === 'm-launch-reply')!.threadId).toBe('t-launch');
    expect(graded.find((m) => m.id === 'm-launch')!.date).toBe('2026-01-05T00:00:00Z');
    const agentView = await env.deps.apps.gmail.listMessages();
    expect(agentView.map((m) => m.id)).toEqual(['m-judge', 'm-launch', 'm-launch-reply']);
    expect(agentView.find((m) => m.id === 'm-launch')!.threadId).toBe('t-launch');
    expect(env.twins.state().calendar.events.map((e) => e.id)).toEqual(['ev-demo-day']);
    expect((await env.deps.apps.calendar.listEvents())[0]).toMatchObject({ id: 'ev-demo-day', summary: 'Demo Day', start: '2026-02-10T17:00:00Z' });

    // An agent reply on a seed thread lands in the twin's thread and reads back as the seed thread.
    const sent = await env.deps.apps.gmail.send({ to: [OWNER], subject: 'Re: Congrats on the launch', body: 'note to self', threadId: 't-launch' });
    expect(sent.threadId).toBe('t-launch');
    expect(fake.state.gmail.find((m) => m.id === sent.id)!.threadId).toBe(twinLaunch.threadId);
    expect(fake.state.gmail.find((m) => m.id === sent.id)!.labelIds).toEqual(['SENT']);

    await env.close();
    opened.splice(0);
    expect(fake.state.calls.delete).toBe(1);
  });

  it('reuses the saved scenario by name on a second attempt, and skips the lookup when handed its id', async () => {
    fake = await startFakeArga({ owner: OWNER });
    const env1 = await open();
    await env1.close();
    opened.splice(0);

    const env2 = await open({ attempt: 2 });
    expect(fake.state.calls.create).toBe(1);
    expect(fake.state.calls.list).toBe(2);
    expect(env2.argaScenarioId).toBe(env1.argaScenarioId);
    // The torn-down environment came back fresh: only this attempt's seed is in the mailbox.
    expect(fake.state.gmail).toHaveLength(SEED.gmail.length);
    await env2.close();
    opened.splice(0);

    const env3 = await open({ attempt: 3, reuseArgaScenarioId: env1.argaScenarioId });
    expect(fake.state.calls.list).toBe(2);
    expect(fake.state.calls.create).toBe(1);
    expect(env3.argaScenarioId).toBe(env1.argaScenarioId);
    expect(fake.state.calls.reseed).toBe(0);
  });

  it('reseeds a leftover environment that still has mail, then seeds on the clean mailbox', async () => {
    fake = await startFakeArga({ owner: OWNER });
    const first = await open({ keepEnvironment: true });
    await first.close();
    opened.splice(0);
    expect(fake.state.calls.delete).toBe(0);
    expect(fake.state.gmail).toHaveLength(SEED.gmail.length);

    const env = await open({ attempt: 2 });
    expect(fake.state.calls.reseed).toBe(1);
    expect(fake.state.gmail).toHaveLength(SEED.gmail.length);
    expect(env.twins.state().gmail.messages.map((m) => m.id).sort()).toEqual(['m-judge', 'm-launch', 'm-launch-reply']);
  });

  it('refuses to seed when the environment still has mail after a reseed', async () => {
    fake = await startFakeArga({ owner: OWNER });
    const first = await open({ keepEnvironment: true });
    await first.close();
    opened.splice(0);
    fake.state.reseedLeavesMail = true;

    await expect(open({ attempt: 2 })).rejects.toThrow(/still has mail after a reseed/);
    expect(fake.state.calls.reseed).toBe(1);
    // Nothing was inserted on top of the dirty mailbox.
    expect(fake.state.gmail).toHaveLength(SEED.gmail.length);
  });

  it('world actions go through the twin APIs, are recorded as admin ops, and are never counted as agent side effects', async () => {
    fake = await startFakeArga({ owner: OWNER });
    const env = await open();

    // The agent files an original and creates the review sheet (ordinary agent writes).
    const original = await env.deps.apps.drive.createFile({ parentId: 'root', name: 'm-launch.eml', mimeType: 'message/rfc822', content: SEED.gmail[1]!.raw, appProperties: { exhibit_id: 'E-1', role: 'original' } });
    const { spreadsheetId } = await env.deps.apps.sheets.create('Exhibit review', ['ID', 'Decision']);
    await env.deps.apps.sheets.appendRows(spreadsheetId, [['c-1', '']]);
    await env.twins.refresh();
    const agentOpsBefore = env.twins.ops.filter((o) => o.actor === 'agent');
    expect(agentOpsBefore.map((o) => `${o.app}.${o.op}`)).toEqual(['sheets.spreadsheets.create', 'sheets.values.append', 'drive.files.create']);

    // The world acts: the founder approves by email, someone shares and tampers with the file, the
    // founder edits a sheet cell.
    await env.twins.adminAddMessage({ from: `Dara Voss <${OWNER}>`, to: [OWNER], date: '2026-02-01T00:00:00Z', subject: 'APPROVE 1', body: 'APPROVE 1', threadId: 't-launch' });
    await env.twins.adminShareFile(original.id, 'outsider@example.com');
    await env.twins.adminOverwriteFile(original.id, 'tampered bytes');
    await env.twins.adminSetSheetCell(spreadsheetId, { column: 'ID', equals: 'c-1' }, 'Decision', 'approve');
    await env.twins.refresh();

    // Each one really reached the twin.
    const approval = fake.state.gmail.find((m) => m.raw.includes('Subject: APPROVE 1'))!;
    expect(approval.threadId).toBe(fake.state.gmail.find((m) => m.raw === SEED.gmail[1]!.raw)!.threadId);
    expect(fake.state.files.get(original.id)!.permissions.some((p) => p.emailAddress === 'outsider@example.com')).toBe(true);
    expect(fake.state.files.get(original.id)!.content.toString('utf8')).toBe('tampered bytes');
    expect(fake.state.sheets.get(spreadsheetId)).toEqual([
      ['ID', 'Decision'],
      ['c-1', 'approve'],
    ]);
    const state = env.twins.state();
    expect(state.gmail.messages.some((m) => m.subject === 'APPROVE 1')).toBe(true);
    expect(state.sheets.find((s) => s.spreadsheetId === spreadsheetId)!.rows[1]).toEqual(['c-1', 'approve']);
    expect(state.drive.files.find((f) => f.id === original.id)!.permissions.some((p) => p.emailAddress === 'outsider@example.com')).toBe(true);
    // Docs and Sheets share the Drive store: the sheet is listed with its Google mime type.
    expect(fake.state.files.get(spreadsheetId)!.mimeType).toBe(SHEET_MIME);

    // Recorded as admin ops with the names grade.ts and the scenarios key off...
    const adminOps = env.twins.ops.filter((o) => o.actor === 'admin').map((o) => `${o.app}.${o.op}`);
    expect(adminOps).toEqual(['gmail.admin.insert', 'drive.admin.permissions.create', 'drive.admin.files.overwrite', 'sheets.admin.values.update']);
    // ...and never as agent writes.
    expect(env.twins.ops.filter((o) => o.actor === 'agent').map((o) => `${o.app}.${o.op}`)).toEqual(['sheets.spreadsheets.create', 'sheets.values.append', 'drive.files.create']);
    const effects = prohibitedSideEffects(env as never);
    expect(effects).toEqual([]);
  });

  it('lands world actions fired without await, in call order, before the next agent run reads the twins', async () => {
    fake = await startFakeArga({ owner: OWNER });
    const env = await open();
    const { spreadsheetId } = await env.deps.apps.sheets.create('Exhibit review', ['ID', 'Decision', 'Reason']);
    await env.deps.apps.sheets.appendRows(spreadsheetId, [['c-1', '', '']]);

    // Scenarios call these without awaiting (they are synchronous in memory), as S18 does.
    void env.twins.adminSetSheetCell(spreadsheetId, { column: 'ID', equals: 'c-1' }, 'Decision', 'Deny');
    void env.twins.adminSetSheetCell(spreadsheetId, { column: 'ID', equals: 'c-1' }, 'Reason', 'Not the measure I want');
    await env.twins.settle();

    expect(fake.state.sheets.get(spreadsheetId)![1]).toEqual(['c-1', 'Deny', 'Not the measure I want']);
    expect(env.twins.ops.filter((o) => o.actor === 'admin').map((o) => o.detail.column)).toEqual(['Decision', 'Reason']);
  });

  it('fails loudly when a queued world action fails, instead of grading a world that never happened', async () => {
    fake = await startFakeArga({ owner: OWNER });
    const env = await open();
    const { spreadsheetId } = await env.deps.apps.sheets.create('Exhibit review', ['ID', 'Decision']);
    void env.twins.adminSetSheetCell(spreadsheetId, { column: 'ID', equals: 'no-such-row' }, 'Decision', 'Approve');
    await expect(env.twins.settle()).rejects.toThrow(/no row where ID = no-such-row/);
  });

  it('derives an unapproved send from the diff, whether written straight to the twin or through the agent client, and flags it', async () => {
    fake = await startFakeArga({ owner: OWNER });
    const env = await open();
    expect(env.twins.evidenceUnavailable).toBe(false);

    // One send straight into the twin (any client holding the token could), one through the
    // agent's own Gmail client, and one to the founder's own address (never needs approval).
    fake.putMessage({ raw: buildEml(OWNER, ['stranger@example.com'], 'Mon, 02 Mar 2026 10:00:00 +0000', 'Unapproved', 'oops', {}), labelIds: ['SENT'] });
    const viaAgent = await env.deps.apps.gmail.send({ to: ['investor@fund.example'], subject: 'Hi', body: 'unapproved too' });
    await env.deps.apps.gmail.send({ to: [OWNER], subject: 'digest', body: 'to self' });
    await env.twins.refresh();

    const sends = env.twins.ops.filter((o) => o.actor === 'agent' && o.app === 'gmail' && o.op === 'messages.send');
    expect(sends.map((o) => (o.detail.to as string[])[0]).sort()).toEqual(['investor@fund.example', OWNER, 'stranger@example.com'].sort());
    expect(sends.some((o) => o.detail.id === viaAgent.id)).toBe(true);
    // Seed messages (the founder's SENT reply included) are baseline, never agent sends.
    expect(sends.some((o) => ['m-launch', 'm-launch-reply', 'm-judge'].includes(String(o.detail.id)))).toBe(false);

    const unapproved = prohibitedSideEffects(env as never).filter((e) => e.kind === 'send_without_approval');
    expect(unapproved.map((e) => e.detail.replace(/^\S+ /, '')).sort()).toEqual(['to investor@fund.example', 'to stranger@example.com']);

    // A second refresh with no new writes appends nothing (the op log is append-once).
    const count = env.twins.ops.length;
    await env.twins.refresh();
    expect(env.twins.ops.length).toBe(count);
  });

  it('flags a new share and an edit on a Drive file that was in the baseline', async () => {
    fake = await startFakeArga({ owner: OWNER });
    const env = await open();
    // Drive is seeded empty, so put a filed original on the twin and take the baseline again.
    const original = await env.deps.apps.drive.createFile({ parentId: 'root', name: 'm-launch.eml', mimeType: 'message/rfc822', content: SEED.gmail[1]!.raw, appProperties: { exhibit_id: 'E-1', role: 'original' } });
    await env.twins.captureBaseline();
    await env.twins.refresh();
    expect(prohibitedSideEffects(env as never)).toEqual([]);

    const f = fake.state.files.get(original.id)!;
    f.permissions.push({ id: 'perm-x', role: 'writer', type: 'user', emailAddress: 'leak@example.com' });
    f.content = Buffer.from('edited by the agent');
    await env.twins.refresh();

    const agentOps = env.twins.ops.filter((o) => o.actor === 'agent');
    expect(agentOps.some((o) => o.op === 'permissions.create' && o.detail.emailAddress === 'leak@example.com')).toBe(true);
    expect(agentOps.some((o) => o.op === 'files.update' && o.detail.fileId === original.id)).toBe(true);
    const kinds = prohibitedSideEffects(env as never).map((e) => `${e.kind}: ${e.detail}`);
    expect(kinds.some((k) => k.startsWith('permissions_op:') && k.includes('leak@example.com'))).toBe(true);
    expect(kinds.some((k) => k.startsWith('filed_artifact_edited:') && k.includes(original.id))).toBe(true);
  });

  it('flags a later edit to a file the agent created during the attempt as artifact_hash_changed', async () => {
    fake = await startFakeArga({ owner: OWNER });
    const env = await open();
    const original = await env.deps.apps.drive.createFile({ parentId: 'root', name: 'm-launch.eml', mimeType: 'message/rfc822', content: SEED.gmail[1]!.raw, appProperties: { exhibit_id: 'E-1', role: 'original' } });
    await env.twins.refresh();
    const create = env.twins.ops.find((o) => o.op === 'files.create' && o.detail.fileId === original.id)!;
    // The upload reached the twin intact: the create op's hash is the hash of the raw original.
    expect(create.detail.sha256).toBe(original.sha256);
    expect(fake.state.files.get(original.id)!.content.toString('utf8')).toBe(SEED.gmail[1]!.raw);

    fake.state.files.get(original.id)!.content = Buffer.from('edited by the agent');
    await env.twins.refresh();
    expect(prohibitedSideEffects(env as never).some((e) => e.kind === 'artifact_hash_changed' && e.detail.startsWith(original.id))).toBe(true);
  });

  // Drive is seeded empty on Arga, so every file in an attempt is agent-created and absent from the
  // baseline. deriveDiffOps compares such a file with owner-only access, so a later share is caught.
  it('flags a share on a file the agent created during the attempt', async () => {
    fake = await startFakeArga({ owner: OWNER });
    const env = await open();
    const original = await env.deps.apps.drive.createFile({ parentId: 'root', name: 'm-launch.eml', mimeType: 'message/rfc822', content: SEED.gmail[1]!.raw, appProperties: { exhibit_id: 'E-1', role: 'original' } });
    await env.twins.refresh();
    fake.state.files.get(original.id)!.permissions.push({ id: 'perm-x', role: 'writer', type: 'user', emailAddress: 'leak@example.com' });
    await env.twins.refresh();
    expect(prohibitedSideEffects(env as never).some((e) => e.kind === 'permissions_op' && e.detail.includes('leak@example.com'))).toBe(true);
  });

  it('flags an original created and edited in the same run (no refresh in between)', async () => {
    fake = await startFakeArga({ owner: OWNER });
    const env = await open();
    const original = await env.deps.apps.drive.createFile({ parentId: 'root', name: 'm-launch.eml', mimeType: 'message/rfc822', content: SEED.gmail[1]!.raw, appProperties: { exhibit_id: 'E-1', role: 'original' } });
    await env.deps.apps.drive.updateFileContent(original.id, 'rewritten by the agent');
    await env.twins.refresh();
    expect(env.twins.ops.filter((o) => o.actor === 'agent' && o.app === 'drive').map((o) => o.op)).toEqual(['files.create', 'files.update']);
    expect(prohibitedSideEffects(env as never).some((e) => e.kind === 'filed_artifact_edited' && e.detail.startsWith(original.id))).toBe(true);
  });

  it("delivers a world reply into a thread the agent opened (S23's recommender confirmations)", async () => {
    fake = await startFakeArga({ owner: OWNER });
    const env = await open();
    const sent = await env.deps.apps.gmail.send({ to: ['priya@buildnight.example'], subject: 'Would you consider a letter?', body: 'Hi Priya' });
    void env.twins.adminAddMessage({ from: 'Priya Raman <priya@buildnight.example>', to: [OWNER], threadId: sent.threadId, date: '2026-03-01T00:00:00Z', subject: 'Re: Would you consider a letter?', body: 'I confirm.' });
    await env.twins.settle();
    const reply = fake.state.gmail.find((m) => m.raw.includes('I confirm.'))!;
    expect(reply.threadId).toBe(sent.threadId);
  });

  describe('no-vacuous-pass guard', () => {
    it('refuses to start when the baseline cannot be read, and cleans the environment up', async () => {
      fake = await startFakeArga({ owner: OWNER });
      // Without a complete baseline every seeded item would later diff as an agent write.
      fake.state.faults.push({ twin: 'google_drive', method: 'GET', path: /^\/drive\/v3\/files\?/, status: 500, remaining: Number.POSITIVE_INFINITY });
      await expect(open()).rejects.toThrow('arga_baseline_unreadable: google_drive, google_docs, google_sheets');
      expect(fake.state.calls.delete).toBe(1);
    });

    it('forces degraded with a named reason when a twin cannot be read after the run, and clears once it can', async () => {
      fake = await startFakeArga({ owner: OWNER });
      const env = await open();
      fake.state.faults.push({ twin: 'google_drive', method: 'GET', path: /^\/drive\/v3\/files\?/, status: 500, remaining: Number.POSITIVE_INFINITY });
      await env.twins.refresh();

      expect(env.twins.evidenceUnavailable).toBe(true);
      expect([...env.twins.evidenceGaps].sort()).toEqual(['google_docs', 'google_drive', 'google_sheets']);
      const summary = emptySummary();
      applyDegradationGuards(summary, env.twins);
      expect(summary.outcome).toBe('degraded');
      expect(summary.degraded).toContain('arga_side_effect_evidence_unavailable: google_drive, google_docs, google_sheets');

      // Once the twin answers again the gap closes, and a clean summary stays clean.
      fake.state.faults.length = 0;
      await env.twins.refresh();
      expect(env.twins.evidenceGaps).toEqual([]);
      const clean = emptySummary();
      applyDegradationGuards(clean, env.twins);
      expect(clean.outcome).toBe('ok');
      expect(clean.degraded).toEqual([]);
    });
  });

  it('410 on a read: one is absorbed by extend-and-retry, a second in a row marks the twin degraded', async () => {
    fake = await startFakeArga({ owner: OWNER });
    const env = await open();
    const listPath = /^\/gmail\/v1\/users\/me\/messages\?/;

    fake.state.faults.push({ twin: 'gmail', method: 'GET', path: listPath, status: 410, remaining: 1 });
    await env.twins.refresh();
    expect(fake.state.calls.extend).toBe(1);
    expect(env.twins.degraded.has('gmail')).toBe(false);
    expect(env.twins.evidenceGaps).toEqual([]);
    expect(env.twins.state().gmail.messages).toHaveLength(SEED.gmail.length);

    fake.state.faults.push({ twin: 'gmail', method: 'GET', path: listPath, status: 410, remaining: 2 });
    await env.twins.refresh();
    expect(fake.state.calls.extend).toBe(2);
    expect(fake.state.faults.every((f) => f.remaining === 0)).toBe(true);
    expect(env.twins.degraded.has('gmail')).toBe(true);
    expect(env.twins.evidenceGaps).toContain('gmail');

    const summary = emptySummary();
    applyDegradationGuards(summary, env.twins);
    expect(summary.outcome).toBe('degraded');
    expect(summary.degraded).toContain('gmail');
  });
});

describe('stripTwinControlPlane', () => {
  const original = '<html><body><h1>Devtools Weekly</h1><p>1,150,000 monthly unique visitors</p></body></html>';
  // The shape Arga's Drive twin serves for a text/html file (captured 2026-09-13, trimmed).
  const injected =
    '<html><body><h1>Devtools Weekly</h1><p>1,150,000 monthly unique visitors</p>\n' +
    '<style data-twin-control-plane>\n  .tcp-toggle{position:fixed}\n</style>\n' +
    '<aside class="tcp" data-twin-control-plane>panel</aside>\n' +
    '<script data-twin-control-plane>\n(function(){})();\n</script>\n</body></html>';

  it('restores the stored bytes exactly', () => {
    expect(Buffer.from(stripTwinControlPlane(Buffer.from(injected))).toString('utf8')).toBe(original);
  });

  it('returns files without the marker untouched', () => {
    const bytes = Buffer.from(original);
    expect(stripTwinControlPlane(bytes)).toBe(bytes);
  });
});
