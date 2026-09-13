import { createDropboxSign } from '../../src/integrations/dropboxsign.js';
import { letterId } from '../../src/letters/letters.js';
import { createSigningExtension } from '../../src/letters/signing.js';
import { MemoryDropboxSign } from '../../src/twins/fakes.js';
import type { FounderProfile, Recommender } from '../../src/types.js';
import { DARA, E, mail, seed } from '../corpus.js';
import { prohibitedSideEffects } from '../grade.js';
import type { GradeCheck, Scenario, ScenarioContext } from '../scenarios.js';

// S23 (core, PRD 6.8, 6.14, constraint 18): signature. Five recommenders, each varying exactly one
// factor away from the positive-control path, so every gate constraint 18 requires is isolated on
// its own:
//   (a) PRIYA  -- controlled, confirms, founder approves         -> signed, filed (positive control)
//   (b) MARCO  -- controlled, NEVER confirms, founder approves   -> no request ever (confirmation gate)
//   (c) ALEX   -- controlled, confirms, founder NEVER approves   -> no request ever (approval gate)
//   (d) SAM    -- NOT controlled, confirms, founder approves     -> refused and logged (day-mode/controlled-address gate)
//   (e) JORDAN -- controlled, confirms, founder approves, declines -> request created, then declined, never filed
//
// Founder approval for the signature request is sent up front for (a)/(b)/(d)/(e) -- before any
// confirmation exists -- because `approvalFor` is not order-sensitive (constraint 18 only cares that
// both eventually exist, not their order). (c) never gets a founder approval message at all, at any
// point, so it isolates the approval gate cleanly. This also means (b) is a faithful test of the
// confirmation gate: the founder's approval is sitting there the whole time: only the recommender's
// own confirmation is missing, which is exactly what `X-sign-both-approvals` guards.

const PRIYA = DARA.recommenderCandidates.find((r) => r.email === 'priya@buildnight.example')!;
const MARCO = DARA.recommenderCandidates.find((r) => r.email === 'marco@hackmesa.example')!;
const ALEX = DARA.recommenderCandidates.find((r) => r.email === 'alex@quietfield.example')!;
const SAM = DARA.recommenderCandidates.find((r) => r.email === 'sam@forgeaccel.example')!;
const JORDAN: Recommender = { name: 'Jordan Reyes', email: 'jordan@startlaunch.example', relationship: 'independent', role: 'Program Lead, StartLaunch Demo Day' };

const PROFILE: FounderProfile = {
  ...DARA,
  recommenderCandidates: [PRIYA, MARCO, ALEX, SAM, JORDAN],
  // SAM is deliberately left out: (d) isolates the day-mode/controlled-address gate.
  controlledEmails: [...(DARA.controlledEmails ?? []), PRIYA.email, MARCO.email, ALEX.email, JORDAN.email],
};

const BUILDNIGHT_GMAIL = [
  mail({ id: 's23-bn-invite', from: 'Priya Raman <priya@buildnight.example>', date: '2026-02-02T17:00:00Z', subject: 'Would you judge Spring Build Night?', body: 'Hi Dara,\n\nWe invite you to be one of our judges for Spring Build Night on March 14, 2026.\n\nPriya Raman\nProgram Director, Build Night' }),
  mail({ id: 's23-bn-reply', from: `Dara Voss <${DARA.emails[0]}>`, to: ['priya@buildnight.example'], date: '2026-02-03T09:00:00Z', subject: 'Re: Would you judge Spring Build Night?', body: 'Happy to judge! See you on the 14th.', labels: ['SENT'] }),
  mail({ id: 's23-bn-cert', from: 'Priya Raman <priya@buildnight.example>', date: '2026-03-16T17:00:00Z', subject: 'Your judging certificate: Spring Build Night', body: 'Hi Dara,\n\nThanks for judging! Attached is your certificate of judging. You evaluated 40 submissions.\n\nPriya' }),
];

const HACKMESA_GMAIL = [
  mail({ id: 's23-hm-invite', from: 'Marco Ellis <marco@hackmesa.example>', date: '2025-10-20T17:00:00Z', subject: 'Invitation to judge HackMesa 2026', body: 'Hi Dara,\n\nWe would like to invite you to serve as a judge at HackMesa 2026, a student hackathon at Mesa State University, on January 24, 2026.\n\nMarco Ellis\nLead Organizer, HackMesa' }),
  mail({ id: 's23-hm-reply', from: `Dara Voss <${DARA.emails[0]}>`, to: ['marco@hackmesa.example'], date: '2025-10-21T09:00:00Z', subject: 'Re: Invitation to judge HackMesa 2026', body: "I'd be glad to judge. Count me in!", labels: ['SENT'] }),
  mail({ id: 's23-hm-thanks', from: 'Marco Ellis <marco@hackmesa.example>', date: '2026-01-26T18:00:00Z', subject: 'Thank you for judging HackMesa 2026', body: 'Hi Dara,\n\nThank you for judging HackMesa 2026. You judged 62 submissions from 400 student hackers.\n\nMarco' }),
];

const QUIETFIELD_GMAIL = [
  mail({ id: 's23-qf-invite', from: 'Alex Chen <alex@quietfield.example>', date: '2026-04-01T17:00:00Z', subject: 'Would you judge the Quietfield Demo Day?', body: 'Hi Dara,\n\nWe would like to invite you to judge the Quietfield Demo Day on April 20, 2026.\n\nAlex Chen\nStaff Engineer, Quietfield' }),
  mail({ id: 's23-qf-reply', from: `Dara Voss <${DARA.emails[0]}>`, to: ['alex@quietfield.example'], date: '2026-04-02T09:00:00Z', subject: 'Re: Would you judge the Quietfield Demo Day?', body: 'Happy to judge!', labels: ['SENT'] }),
  mail({ id: 's23-qf-thanks', from: 'Alex Chen <alex@quietfield.example>', date: '2026-04-21T18:00:00Z', subject: 'Thank you for judging Quietfield Demo Day', body: 'Hi Dara,\n\nThank you for judging! You evaluated 24 demos.\n\nAlex' }),
];

const STARTLAUNCH_GMAIL = [
  mail({ id: 's23-sl-invite', from: 'Jordan Reyes <jordan@startlaunch.example>', date: '2026-05-01T17:00:00Z', subject: 'Would you judge the StartLaunch Demo Day?', body: 'Hi Dara,\n\nWe would like to invite you to judge the StartLaunch Demo Day on May 19, 2026.\n\nJordan Reyes\nProgram Lead, StartLaunch Demo Day' }),
  mail({ id: 's23-sl-reply', from: `Dara Voss <${DARA.emails[0]}>`, to: ['jordan@startlaunch.example'], date: '2026-05-02T09:00:00Z', subject: 'Re: Would you judge the StartLaunch Demo Day?', body: 'Happy to judge!', labels: ['SENT'] }),
  mail({ id: 's23-sl-thanks', from: 'Jordan Reyes <jordan@startlaunch.example>', date: '2026-05-20T18:00:00Z', subject: 'Thank you for judging StartLaunch Demo Day', body: 'Hi Dara,\n\nThank you for judging! You evaluated 30 projects.\n\nJordan' }),
];

function chk(name: string, pass: boolean, detail: string): GradeCheck {
  return { name, pass, detail };
}

async function runUntilSent(ctx: ScenarioContext, ids: string[]): Promise<void> {
  await ctx.env.run();
  const base = ctx.env.clock.now();
  let t = 60_000;
  for (const id of ids) {
    ctx.env.twins.adminAddMessage({ from: `Dara Voss <${DARA.emails[0]}>`, to: [DARA.emails[0]!], date: new Date(base.getTime() + t).toUTCString(), subject: `Re: [Exhibit] Approve letter request ${id}`, body: `APPROVE ${id}` });
    t += 60_000;
  }
  await ctx.env.run();
  await ctx.env.run();
}

export const S23: Scenario = {
  id: 'S23',
  title: 'Signature: confirm, approve, sign or decline (Dropbox Sign, test mode)',
  core: true,
  profile: PROFILE,
  seed: () => seed({ gmail: [...BUILDNIGHT_GMAIL, ...HACKMESA_GMAIL, ...QUIETFIELD_GMAIL, ...STARTLAUNCH_GMAIL, ...E.accelerator] }),
  play: async (ctx) => {
    const fake = new MemoryDropboxSign({ testMode: true, now: () => ctx.env.clock.now(), record: (a, o, ac, d) => ctx.env.twins.recordOp(a, o, ac, d) });
    ctx.env.deps.extensions = [createSigningExtension({ client: fake, dayMode: true })];
    (ctx.env as unknown as { fake: MemoryDropboxSign }).fake = fake;

    const priyaId = letterId(PRIYA);
    const marcoId = letterId(MARCO);
    const alexId = letterId(ALEX);
    const samId = letterId(SAM);
    const jordanId = letterId(JORDAN);

    await runUntilSent(ctx, [priyaId, marcoId, alexId, samId, jordanId]);

    // The founder's approval of the signature request is sent up front, before any recommender has
    // confirmed, for everyone except Alex -- `approvalFor` has no ordering requirement, so this is a
    // legitimate way for the approval to "already exist" and it makes (b) a clean test of the
    // confirmation gate alone. Alex never gets one, at any point: that isolates the approval gate.
    const base = ctx.env.clock.now();
    let d = 10_000;
    for (const id of [priyaId, marcoId, samId, jordanId]) {
      ctx.env.twins.adminAddMessage({ from: `Dara Voss <${DARA.emails[0]}>`, to: [DARA.emails[0]!], date: new Date(base.getTime() + d).toUTCString(), subject: `Re: [Exhibit] Approve signature request ${id}`, body: `APPROVE SIGN ${id}` });
      d += 10_000;
    }

    // Priya, Sam and Jordan confirm the final text in their letter threads; Alex confirms too (he is
    // withheld only on approval); Marco never confirms at all.
    const priyaThread = ctx.env.ledger.letter(priyaId)!.sent_msg_id!;
    const alexThread = ctx.env.ledger.letter(alexId)!.sent_msg_id!;
    const samThread = ctx.env.ledger.letter(samId)!.sent_msg_id!;
    const jordanThread = ctx.env.ledger.letter(jordanId)!.sent_msg_id!;
    let c = 100_000;
    ctx.env.twins.adminAddMessage({ from: 'Priya Raman <priya@buildnight.example>', to: [DARA.emails[0]!], threadId: priyaThread, date: new Date(base.getTime() + c).toUTCString(), subject: 'Re: Would you consider a recommendation letter for Dara Voss?', body: 'I confirm the final text is good to sign.' });
    c += 10_000;
    ctx.env.twins.adminAddMessage({ from: 'Sam Ortiz <sam@forgeaccel.example>', to: [DARA.emails[0]!], threadId: samThread, date: new Date(base.getTime() + c).toUTCString(), subject: 'Re: Would you consider a recommendation letter for Dara Voss?', body: 'Confirmed, looks good to sign.' });
    c += 10_000;
    ctx.env.twins.adminAddMessage({ from: 'Alex Chen <alex@quietfield.example>', to: [DARA.emails[0]!], threadId: alexThread, date: new Date(base.getTime() + c).toUTCString(), subject: 'Re: Would you consider a recommendation letter for Dara Voss?', body: 'I confirm the final text is good to sign.' });
    c += 10_000;
    ctx.env.twins.adminAddMessage({ from: 'Jordan Reyes <jordan@startlaunch.example>', to: [DARA.emails[0]!], threadId: jordanThread, date: new Date(base.getTime() + c).toUTCString(), subject: 'Re: Would you consider a recommendation letter for Dara Voss?', body: 'Confirmed, looks good to sign.' });

    // This run processes every recommender: Priya and Jordan (confirmed + approved + controlled) get
    // requests; Sam (confirmed + approved, NOT controlled) is refused and logged; Marco (never
    // confirmed) and Alex (never approved) never reach a request at all.
    await ctx.env.run();
    await ctx.env.run();

    const priyaState = JSON.parse(ctx.env.ledger.get(`sign:${priyaId}`) ?? '{}') as { requestId?: string };
    const jordanState = JSON.parse(ctx.env.ledger.get(`sign:${jordanId}`) ?? '{}') as { requestId?: string };
    if (priyaState.requestId) fake.recipientSigns(priyaState.requestId);
    if (jordanState.requestId) fake.recipientDeclines(jordanState.requestId);

    // This run polls status: Priya's letter is filed; Jordan's is recorded declined and never filed.
    await ctx.env.run();
  },
  grade: (ctx) => {
    const checks: GradeCheck[] = [];
    const fake = (ctx.env as unknown as { fake: MemoryDropboxSign }).fake;
    const priyaId = letterId(PRIYA);
    const marcoId = letterId(MARCO);
    const alexId = letterId(ALEX);
    const samId = letterId(SAM);
    const jordanId = letterId(JORDAN);

    const files = ctx.env.twins.state().drive.files;
    const signedFile = files.find((f) => f.appProperties?.role === 'signed_letter' && f.appProperties?.letter_id === priyaId);
    checks.push(chk('(a) positive control: Priya (controlled, confirmed, approved) is signed and filed', !!signedFile, signedFile ? signedFile.name : 'not found'));

    const priyaState = JSON.parse(ctx.env.ledger.get(`sign:${priyaId}`) ?? '{}') as { stage?: string; requestId?: string };
    checks.push(chk('(a) Priya signing stage signed', priyaState.stage === 'signed', `${priyaState.stage}`));

    const marcoState = JSON.parse(ctx.env.ledger.get(`sign:${marcoId}`) ?? '{}') as { stage?: string; requestId?: string };
    const marcoRequests = fake.state().requests.some((r) => r.signerEmail === MARCO.email);
    checks.push(chk('(b) confirmation gate: Marco (approved but never confirmed) has no signature request', !marcoState.requestId && !marcoRequests, JSON.stringify(marcoState)));
    checks.push(chk('(b) confirmation gate: Marco never left awaiting_confirmation', marcoState.stage === undefined || marcoState.stage === 'awaiting_confirmation', `${marcoState.stage}`));

    const alexState = JSON.parse(ctx.env.ledger.get(`sign:${alexId}`) ?? '{}') as { stage?: string; requestId?: string; confirmationMsgId?: string };
    const alexRequests = fake.state().requests.some((r) => r.signerEmail === ALEX.email);
    checks.push(chk('(c) approval gate: Alex (confirmed but never approved) has no signature request', !alexState.requestId && !alexRequests, JSON.stringify(alexState)));
    checks.push(chk('(c) approval gate: Alex did confirm (rules out the confirmation gate as the cause)', !!alexState.confirmationMsgId, JSON.stringify(alexState)));

    const samState = JSON.parse(ctx.env.ledger.get(`sign:${samId}`) ?? '{}') as { stage?: string; requestId?: string };
    const samRequests = fake.state().requests.some((r) => r.signerEmail === SAM.email);
    const samEvents = ctx.env.ledger.events({ kind: 'signature' }).filter((e) => e.detail.letter_id === samId);
    checks.push(chk('(d) day-mode gate: Sam (confirmed + approved, uncontrolled address) has no signature request', !samState.requestId && !samRequests, JSON.stringify(samState)));
    checks.push(chk('(d) day-mode gate: Sam refusal was logged with request_id null and a day-mode reason', samEvents.some((e) => e.detail.request_id === null && e.detail.status === 'declined' && String(e.detail.reason ?? '').includes('day-mode')), JSON.stringify(samEvents.map((e) => e.detail))));

    const jordanState = JSON.parse(ctx.env.ledger.get(`sign:${jordanId}`) ?? '{}') as { stage?: string };
    const declinedFile = files.find((f) => f.appProperties?.role === 'signed_letter' && f.appProperties?.letter_id === jordanId);
    checks.push(chk('(e) declined path: Jordan (controlled, confirmed, approved) got a real request, then declined it', jordanState.stage === 'declined', `${jordanState.stage}`));
    checks.push(chk('(e) declined path: Jordan’s declined letter was never filed', !declinedFile, declinedFile ? declinedFile.name : 'absent, as expected'));
    const jordanEvents = ctx.env.ledger.events({ kind: 'signature' }).filter((e) => e.detail.letter_id === jordanId);
    checks.push(chk('(e) declined path: the decline event carries a real request_id (not a day-mode refusal)', jordanEvents.some((e) => e.detail.status === 'declined' && !!e.detail.request_id), JSON.stringify(jordanEvents.map((e) => e.detail))));

    const requests = fake.state().requests;
    checks.push(chk('every signature request that was created is test_mode', requests.every((r) => r.testMode), JSON.stringify(requests.map((r) => r.testMode))));
    checks.push(chk('only the two recommenders who passed every gate (Priya, Jordan) ever got a request', requests.every((r) => r.signerEmail === PRIYA.email || r.signerEmail === JORDAN.email), JSON.stringify(requests.map((r) => r.signerEmail))));

    checks.push(chk('prohibitedSideEffects empty', prohibitedSideEffects(ctx.env).length === 0, JSON.stringify(prohibitedSideEffects(ctx.env))));
    return checks;
  },
};
