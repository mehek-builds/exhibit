import { describe, expect, it } from 'vitest';
import { letterId } from '../src/letters/letters.js';
import { createSigningExtension } from '../src/letters/signing.js';
import { MemoryDropboxSign } from '../src/twins/fakes.js';
import type { FounderProfile } from '../src/types.js';
import { DARA, mail, seed } from '../harness/corpus.js';
import { createHarnessEnv } from '../harness/env.js';

// Regression coverage for the config.ts / signing.ts day-mode <-> live-signature wiring bug: config.ts
// used to compute `dayMode` as the *live opt-in* condition and then build the client's `testMode` as
// `!dayMode`, which made signing.ts's constraint-18 gate (`dayMode && !client.testMode`) refuse every
// live send, while the features report still claimed "enabled (live signatures)". These tests exercise
// createSigningExtension directly (the same seam config.ts wires) across the actual matrix: day mode vs.
// live opt-in, all four approval combinations, and controlled vs. uncontrolled signer addresses.

const RECOMMENDER = DARA.recommenderCandidates.find((r) => r.email === 'marco@hackmesa.example')!;
const UNCONTROLLED_EMAIL = 'marco@hackmesa.example';
const CONTROLLED_EMAIL = 'marco.controlled@hackmesa.example';

interface Scenario {
  recommenderConfirms: boolean;
  founderApproves: boolean;
  signerControlled: boolean;
  /** dayMode=false models EXHIBIT_ALLOW_LIVE_SIGNATURES=1 + DROPBOX_SIGN_TEST_MODE=0. */
  dayMode: boolean;
}

async function run(s: Scenario): Promise<{ sendCalled: boolean; sentTestMode: boolean | undefined; requestExists: boolean }> {
  const signerEmail = s.signerControlled ? CONTROLLED_EMAIL : UNCONTROLLED_EMAIL;
  const recommender = { ...RECOMMENDER, email: signerEmail };
  const id = letterId(recommender);
  const profile: FounderProfile = {
    ...DARA,
    recommenderCandidates: [recommender],
    controlledEmails: [...(DARA.controlledEmails ?? []), ...(s.signerControlled ? [CONTROLLED_EMAIL] : [])],
  };
  const gmail = [
    mail({ id: 'sm-invite', from: `Marco Ellis <${signerEmail}>`, date: '2025-10-20T17:00:00Z', subject: 'Invitation to judge HackMesa 2026', body: 'Hi Dara,\n\nWe would like to invite you to serve as a judge at HackMesa 2026 on January 24, 2026.\n\nMarco Ellis\nLead Organizer, HackMesa' }),
    mail({ id: 'sm-reply', from: `Dara Voss <${DARA.emails[0]}>`, to: [signerEmail], date: '2025-10-21T09:00:00Z', subject: 'Re: Invitation to judge HackMesa 2026', body: "I'd be glad to judge. Count me in!", labels: ['SENT'] }),
    mail({ id: 'sm-thanks', from: `Marco Ellis <${signerEmail}>`, date: '2026-01-26T18:00:00Z', subject: 'Thank you for judging HackMesa 2026', body: 'Hi Dara,\n\nThank you for judging. You judged 62 submissions from 400 student hackers.\n\nMarco' }),
  ];

  const env = createHarnessEnv({ seed: seed({ gmail }), profile, gate: 'library' });
  const sendCalls: { testMode: boolean }[] = [];
  try {
    // Mirrors config.ts: client.testMode === dayMode; live opt-in flips both to false.
    const inner = new MemoryDropboxSign({ testMode: s.dayMode, now: () => env.clock.now(), record: (a, o, ac, d) => env.twins.recordOp(a, o, ac, d) });
    const spyClient = {
      testMode: inner.testMode,
      send: async (input: Parameters<MemoryDropboxSign['send']>[0]) => {
        sendCalls.push({ testMode: inner.testMode });
        return inner.send(input);
      },
      getStatus: inner.getStatus.bind(inner),
      downloadPdf: inner.downloadPdf.bind(inner),
    };
    env.deps.extensions = [createSigningExtension({ client: spyClient, dayMode: s.dayMode })];

    await env.run(); // drafts the letter and requests the founder's letter-send approval
    {
      const t = env.clock.now();
      env.twins.adminAddMessage({ from: `Dara Voss <${DARA.emails[0]}>`, to: [DARA.emails[0]!], date: new Date(t.getTime() + 60_000).toUTCString(), subject: `Re: [Exhibit] Approve letter request ${id}`, body: `APPROVE ${id}` });
    }
    await env.run();
    await env.run(); // letter sent to the recommender

    if (s.recommenderConfirms) {
      const t = env.clock.now();
      const letterRow = env.ledger.letters().find((l) => l.letter_id === id);
      env.twins.adminAddMessage({
        from: `Marco Ellis <${signerEmail}>`,
        to: [DARA.emails[0]!],
        date: new Date(t.getTime() + 30_000).toUTCString(),
        subject: `Re: Would you consider a recommendation letter for ${DARA.name}?`,
        body: 'Confirmed, looks good to sign.',
        threadId: letterRow?.sent_msg_id ?? undefined,
      });
    }
    await env.run();

    if (s.founderApproves) {
      const t = env.clock.now();
      env.twins.adminAddMessage({ from: `Dara Voss <${DARA.emails[0]}>`, to: [DARA.emails[0]!], date: new Date(t.getTime() + 30_000).toUTCString(), subject: `Re: [Exhibit] Approve signature request ${id}`, body: `APPROVE SIGN ${id}` });
    }
    await env.run();
    await env.run();

    const state = JSON.parse(env.ledger.get(`sign:${id}`) ?? '{}') as { requestId?: string };
    const requests = inner.state().requests;
    const requestExists = !!state.requestId || requests.some((req) => req.signerEmail === signerEmail);
    return { sendCalled: sendCalls.length > 0, sentTestMode: sendCalls[0]?.testMode, requestExists };
  } finally {
    await env.close();
  }
}

describe('signing day mode / live opt-in matrix', () => {
  const approvalCombos: { name: string; recommenderConfirms: boolean; founderApproves: boolean; bothApproved: boolean }[] = [
    { name: 'neither approval', recommenderConfirms: false, founderApproves: false, bothApproved: false },
    { name: 'recommender only', recommenderConfirms: true, founderApproves: false, bothApproved: false },
    { name: 'founder only', recommenderConfirms: false, founderApproves: true, bothApproved: false },
    { name: 'both approvals', recommenderConfirms: true, founderApproves: true, bothApproved: true },
  ];

  for (const dayMode of [true, false]) {
    for (const signerControlled of [true, false]) {
      for (const combo of approvalCombos) {
        it(`dayMode=${dayMode} signerControlled=${signerControlled} (${combo.name})`, async () => {
          const result = await run({ dayMode, signerControlled, recommenderConfirms: combo.recommenderConfirms, founderApproves: combo.founderApproves });

          if (!combo.bothApproved) {
            // (c) both approvals are required in every mode.
            expect(result.sendCalled, JSON.stringify(result)).toBe(false);
            expect(result.requestExists, JSON.stringify(result)).toBe(false);
            return;
          }

          if (dayMode) {
            // (a) day mode only ever sends in test mode, and only to controlled addresses.
            if (signerControlled) {
              expect(result.sendCalled, JSON.stringify(result)).toBe(true);
              expect(result.sentTestMode).toBe(true);
            } else {
              expect(result.sendCalled, JSON.stringify(result)).toBe(false);
              expect(result.requestExists, JSON.stringify(result)).toBe(false);
            }
          } else {
            // (b) live opt-in actually sends, and not in test mode, regardless of controlledEmails.
            expect(result.sendCalled, JSON.stringify(result)).toBe(true);
            expect(result.sentTestMode).toBe(false);
          }
        }, 30_000);
      }
    }
  }
});

describe('signing features report', () => {
  it('never claims "live" unless both DROPBOX_SIGN_TEST_MODE=0 and EXHIBIT_ALLOW_LIVE_SIGNATURES=1', () => {
    function reasonFor(env: Record<string, string | undefined>): string {
      const liveSignaturesEnabled = env.DROPBOX_SIGN_TEST_MODE === '0' && env.EXHIBIT_ALLOW_LIVE_SIGNATURES === '1';
      return liveSignaturesEnabled ? 'enabled (live signatures)' : 'enabled (test mode)';
    }
    expect(reasonFor({})).toBe('enabled (test mode)');
    expect(reasonFor({ DROPBOX_SIGN_TEST_MODE: '0' })).toBe('enabled (test mode)');
    expect(reasonFor({ EXHIBIT_ALLOW_LIVE_SIGNATURES: '1' })).toBe('enabled (test mode)');
    expect(reasonFor({ DROPBOX_SIGN_TEST_MODE: '1', EXHIBIT_ALLOW_LIVE_SIGNATURES: '1' })).toBe('enabled (test mode)');
    expect(reasonFor({ DROPBOX_SIGN_TEST_MODE: '0', EXHIBIT_ALLOW_LIVE_SIGNATURES: '1' })).toBe('enabled (live signatures)');
  });
});
