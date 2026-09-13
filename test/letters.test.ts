import { describe, expect, it } from 'vitest';
import { evaluateMessage } from 'worth-sending-mcp';
import { buildPacket, draftLetter, letterId, processLetters } from '../src/letters/letters.js';
import type { LetterDeps } from '../src/letters/letters.js';
import { LibraryWorthSendingGate, McpWorthSendingGate, UnavailableGate } from '../src/letters/worthSending.js';
import { Ledger } from '../src/ledger.js';
import { LocalTracer } from '../src/observability/tracer.js';
import type { ExhibitRecord, FounderProfile } from '../src/types.js';
import { DARA, E, NOW, seed } from '../harness/corpus.js';
import { createHarnessEnv } from '../harness/env.js';
import { MemoryTwins } from '../src/twins/memory.js';
import { PROFILE } from './helpers.js';

function baseExhibit(p: Partial<ExhibitRecord> & { exhibit_id: string; people: ExhibitRecord['people'] }): ExhibitRecord {
  return {
    key: p.exhibit_id,
    criteria: [4],
    eb1a_criteria: ['iv'],
    status: 'qualifying',
    eb1a_status: 'qualifying',
    comparable: false,
    comparable_for: [],
    rule_id: 'C4-service-proof',
    metrics: {},
    title: 'Judge, Spring Build Night',
    issuer: 'buildnight.example',
    event_date: '2026-03-14',
    captured_at: NOW.toISOString(),
    sources: [],
    artifact_path: '04-judging/EX-4-001/',
    sha256: 'abc',
    reason: 'reason',
    version: 1,
    supersedes: null,
    ...p,
  } as ExhibitRecord;
}

async function makeLetterDeps(profile: FounderProfile): Promise<{ deps: LetterDeps; ledger: Ledger; twins: MemoryTwins }> {
  const twins = new MemoryTwins(seed({}), { now: () => NOW });
  const ledger = new Ledger(':memory:');
  const tracer = new LocalTracer(null);
  const trace = (await tracer.run({ name: 'test', runId: 'r1', input: {} }, async (c) => c)).result;
  const deps: LetterDeps = { apps: twins.apps, ledger, trace, profile, gate: new LibraryWorthSendingGate(), runId: 'r1', now: NOW, allMessages: [], founderMessages: [] };
  return { deps, ledger, twins };
}

describe('letters: a recommender with no exhibit linked to them produces no draft (E23)', () => {
  it('every recommender is skipped when the ledger has no qualifying exhibits', async () => {
    const { deps } = await makeLetterDeps(DARA);
    const summary = await processLetters(deps);
    expect(summary.drafted).toHaveLength(0);
    expect(summary.skipped.length).toBe(DARA.recommenderCandidates.length);
    expect(summary.skipped.every((s) => s.reason === 'no linked qualifying exhibit')).toBe(true);
  });
});

describe('letters: a recipient at an attorney or government domain is skipped (constraint 2)', () => {
  it('skips a recommender at a *-law.com domain even with a linked exhibit', async () => {
    const profile: FounderProfile = { ...DARA, recommenderCandidates: [{ name: 'Outside Counsel', email: 'counsel@acmelaw.com', relationship: 'independent', role: 'Attorney' }] };
    const { deps, ledger } = await makeLetterDeps(profile);
    ledger.insertExhibit(baseExhibit({ exhibit_id: 'EX-4-001', people: [{ name: 'Outside Counsel', email: 'counsel@acmelaw.com' }] }), 'r1', null);
    const summary = await processLetters(deps);
    expect(summary.skipped).toHaveLength(1);
    expect(summary.skipped[0]!.reason).toMatch(/attorney or government domain/);
  });

  it('skips a recipient at uscis.gov as well', async () => {
    const profile: FounderProfile = { ...DARA, recommenderCandidates: [{ name: 'Officer', email: 'someone@uscis.gov', relationship: 'independent', role: 'Officer' }] };
    const { deps, ledger } = await makeLetterDeps(profile);
    ledger.insertExhibit(baseExhibit({ exhibit_id: 'EX-4-002', people: [{ name: 'Officer', email: 'someone@uscis.gov' }] }), 'r1', null);
    const summary = await processLetters(deps);
    expect(summary.skipped[0]!.reason).toMatch(/attorney or government domain/);
  });
});

describe('letters: buildPacket output validates against worth-sending\'s own schema', () => {
  it('evaluateMessage does not throw when given buildPacket\'s output', async () => {
    const { deps } = await makeLetterDeps(DARA);
    const r = DARA.recommenderCandidates[0]!;
    const exhibits = [baseExhibit({ exhibit_id: 'EX-4-003', people: [{ name: r.name, email: r.email }] })];
    const draft = draftLetter(r, exhibits, DARA);
    const packet = buildPacket(r, exhibits, `Ask message.\n\n${draft}`, deps, letterId(r));
    expect(() => evaluateMessage(packet)).not.toThrow();
    const result = evaluateMessage(packet);
    expect(['send', 'revise', 'hold']).toContain(result.decision);
  });
});

// ---------------------------------------------------------------------------
// Full-pipeline tests (via the harness env) for timing, approval and send flow
// ---------------------------------------------------------------------------

describe('letters: a "busy" timing signal produces a hold with a Timing reason and no send (E19)', () => {
  it('holds when the recommender recently signalled they are launching this week', async () => {
    const busyMail = { id: 'm-bn-busy', from: 'Priya Raman <priya@buildnight.example>', to: [DARA.emails[0]!], date: 'Thu, 10 Sep 2026 12:00:00 GMT', subject: 'Quick heads up', body: "We're launching this week, so I'm heads-down until Friday.", headers: {}, labels: ['INBOX'], threadId: 'm-bn-busy', raw: '' };
    const s = seed({ gmail: [...E.buildnight.gmail, busyMail as never], calendar: [...E.buildnight.calendar] });
    const env = createHarnessEnv({ seed: s, gate: 'library' });
    const summary = await env.run();
    const held = summary.letters!.held.find((h) => h.letter_id === 'LTR-priya');
    expect(held).toBeDefined();
    expect(held!.reasons.some((r) => /Timing/i.test(r))).toBe(true);
    expect(summary.letters!.sent).toHaveLength(0);
    expect(summary.letters!.approvalRequested).not.toContain('LTR-priya');
    await env.close();
  });
});

describe('letters: good timing produces an approval request sent to the founder (self) only', () => {
  it('worth-sending recommends send, and the approval-request email goes only to the founder', async () => {
    const s = seed({ gmail: [...E.buildnight.gmail], calendar: [...E.buildnight.calendar] });
    const env = createHarnessEnv({ seed: s, gate: 'library' });
    const summary = await env.run();
    expect(summary.letters!.approvalRequested).toContain('LTR-priya');
    expect(summary.letters!.sent).toHaveLength(0); // no letter to the recommender yet -- only the self-approval ask
    const sentMessages = await env.deps.apps.gmail.listMessages();
    const approvalAsk = sentMessages.find((m) => m.labels.includes('SENT') && m.subject.includes('LTR-priya'));
    expect(approvalAsk).toBeDefined();
    expect(approvalAsk!.to).toEqual([DARA.emails[0]]);
    expect(approvalAsk!.to).not.toContain('priya@buildnight.example');
    await env.close();
  });
});

describe('letters: no APPROVE reply means nothing is ever sent (E20)', () => {
  it('a second run with no approval reply leaves the letter pending, unsent', async () => {
    const s = seed({ gmail: [...E.buildnight.gmail], calendar: [...E.buildnight.calendar] });
    const env = createHarnessEnv({ seed: s, gate: 'library' });
    await env.run(); // approval requested
    await env.run(); // no reply yet
    const letter = env.ledger.letter('LTR-priya')!;
    expect(letter.state).toBe('approval_requested');
    const sentMessages = await env.deps.apps.gmail.listMessages();
    const letterRequestSubject = `Would you consider a recommendation letter for ${DARA.name}?`;
    expect(sentMessages.some((m) => m.to.includes('priya@buildnight.example') && m.subject === letterRequestSubject)).toBe(false);
    await env.close();
  });
});

describe('letters: APPROVE arriving twice results in exactly ONE send (E21)', () => {
  it('is idempotent across repeated runs even with a duplicate APPROVE message', async () => {
    const s = seed({ gmail: [...E.buildnight.gmail], calendar: [...E.buildnight.calendar] });
    const env = createHarnessEnv({ seed: s, gate: 'library' });
    await env.run(); // approval requested

    env.twins.adminAddMessage({ from: `Dara Voss <${DARA.emails[0]}>`, to: [DARA.emails[0]!], date: env.clock.now().toUTCString(), subject: 'Re: [Exhibit] Approve letter request LTR-priya to Priya Raman', body: 'APPROVE LTR-priya' });
    const afterApprove = await env.run();
    expect(afterApprove.letters!.sent).toContain('LTR-priya');

    // A second, duplicate APPROVE arrives; the letter is already 'sent' and is skipped outright.
    env.twins.adminAddMessage({ from: `Dara Voss <${DARA.emails[0]}>`, to: [DARA.emails[0]!], date: env.clock.now().toUTCString(), subject: 'APPROVE again', body: 'APPROVE LTR-priya' });
    await env.run();

    const sentMessages = await env.deps.apps.gmail.listMessages();
    const letterRequestSubject = `Would you consider a recommendation letter for ${DARA.name}?`;
    const toRecommender = sentMessages.filter((m) => m.labels.includes('SENT') && m.to.includes('priya@buildnight.example') && m.subject === letterRequestSubject);
    expect(toRecommender).toHaveLength(1);
    await env.close();
  });
});

describe('letters: an UnavailableGate results in held/no-send, never a fallback auto-send (E22)', () => {
  it('every evaluable letter is held when worth-sending is not running', async () => {
    const s = seed({ gmail: [...E.buildnight.gmail], calendar: [...E.buildnight.calendar] });
    const env = createHarnessEnv({ seed: s, gate: 'unavailable' });
    const summary = await env.run();
    expect(summary.letters!.held.some((h) => h.letter_id === 'LTR-priya')).toBe(true);
    expect(summary.letters!.approvalRequested).toHaveLength(0);
    expect(summary.letters!.sent).toHaveLength(0);
    const letter = env.ledger.letter('LTR-priya')!;
    expect(letter.state).toBe('held');
    expect(letter.ws_decision).toBe('hold');
    await env.close();
  });
});

describe('letters: an APPROVE reply for a different letter id does not trigger a send for this letter', () => {
  it('approving LTR-priya never sends LTR-marco', async () => {
    const s = seed({
      gmail: [...E.buildnight.gmail, ...E.hackmesa.gmail],
      calendar: [...E.buildnight.calendar, ...E.hackmesa.calendar],
    });
    const env = createHarnessEnv({ seed: s, gate: 'library' });
    await env.run(); // both should reach approval_requested (or at least buildnight does)
    const priyaLetter = env.ledger.letter('LTR-priya');
    expect(priyaLetter?.state).toBe('approval_requested');

    env.twins.adminAddMessage({ from: `Dara Voss <${DARA.emails[0]}>`, to: [DARA.emails[0]!], date: env.clock.now().toUTCString(), subject: 'Re: approve', body: 'APPROVE LTR-priya' });
    await env.run();

    const marcoLetter = env.ledger.letter('LTR-marco');
    if (marcoLetter) expect(marcoLetter.state).not.toBe('sent');
    const sentMessages = await env.deps.apps.gmail.listMessages();
    const letterRequestSubject = `Would you consider a recommendation letter for ${DARA.name}?`;
    expect(sentMessages.some((m) => m.to.includes('marco@hackmesa.example') && m.labels.includes('SENT') && m.subject === letterRequestSubject)).toBe(false);
    expect(sentMessages.some((m) => m.to.includes('priya@buildnight.example') && m.labels.includes('SENT') && m.subject === letterRequestSubject)).toBe(true);
    await env.close();
  });
});

describe('letters: the real stdio MCP transport (McpWorthSendingGate) works end-to-end', () => {
  it('evaluates a packet through the actual worth-sending-mcp server process', async () => {
    const { deps } = await makeLetterDeps(DARA);
    const r = DARA.recommenderCandidates[0]!;
    const exhibits = [baseExhibit({ exhibit_id: 'EX-4-004', people: [{ name: r.name, email: r.email }] })];
    const draft = draftLetter(r, exhibits, DARA);
    const packet = buildPacket(r, exhibits, `Ask message.\n\n${draft}`, deps, letterId(r));

    const gate = new McpWorthSendingGate();
    try {
      const decision = await gate.evaluate(packet);
      expect(['send', 'revise', 'hold']).toContain(decision.decision);
      expect(decision.transport).toBe('mcp');
      expect(typeof decision.score === 'number' || decision.score === null).toBe(true);
    } finally {
      await gate.close();
    }
  }, 30_000);
});
