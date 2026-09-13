import type { GmailMessage } from '../../src/apps/types.js';
import { letterId } from '../../src/letters/letters.js';
import type { HarnessEnv } from '../env.js';
import type { Scenario } from '../scenarios.js';
import { DARA, E, seed } from '../corpus.js';

// The self-approval defect (PRD 12.6 loop; harness S13 caught the re-run symptom, but the lifted-
// scenario JSON format (harness/lifted/README.md) only expresses mapping expectations -- it has no
// way to say "an email must never be sent". The defect is letters/approval behaviour, so it needs
// a hand-written core scenario instead of a lifted JSON file. harness/lifted/S19-self-approval.json
// is the record that points here; this file is what actually runs.
//
// Failing input, reproduced exactly: Build Night seed, Dara's only recommender candidate is Priya
// Raman. Run 1 drafts the letter, worth-sending says send, and Exhibit emails itself an
// "[Exhibit] Approve letter request LTR-priya to Priya Raman" message containing the literal line
// `APPROVE LTR-priya` as copy text for Priya to see what would go out. On the defect, a re-run read
// that copy text as the founder's own approval and sent to Priya with nobody having replied.

const PRIYA = DARA.recommenderCandidates.find((r) => r.email === 'priya@buildnight.example')!;
const PROFILE_PRIYA_ONLY = { ...DARA, recommenderCandidates: [PRIYA] };

function priyaSends(env: HarnessEnv) {
  return env.twins.ops.filter((o) => o.actor === 'agent' && o.app === 'gmail' && o.op === 'messages.send' && ((o.detail.to as string[]) ?? []).includes('priya@buildnight.example'));
}

/**
 * S19: three runs, never a founder reply. Pass means the bug stays fixed: zero sends to Priya ever,
 * the letter row stuck at `approval_requested`, no `letter_sent` event, and no prohibited side
 * effect (the grader's own send-without-approval check, PRD constraint 1) on any attempt.
 */
export const S19: Scenario = {
  id: 'S19',
  title: 'Self-approval: agent approval request never read as the founder\'s own approval',
  core: true,
  profile: PROFILE_PRIYA_ONLY,
  seed: () => seed({ gmail: E.buildnight.gmail, calendar: E.buildnight.calendar }),
  play: async (ctx) => {
    await ctx.env.run();
    await ctx.env.run();
    await ctx.env.run();
  },
  grade: (ctx) => {
    const { env } = ctx;
    const id = letterId(PRIYA);
    const letter = env.ledger.letter(id);
    const sends = priyaSends(env);
    const letterSentEvents = env.ledger.events({ kind: 'letter_sent' }).filter((e) => e.detail.letter_id === id);
    return [
      { name: 'zero agent sends to priya@buildnight.example across all 3 runs', pass: sends.length === 0, detail: JSON.stringify(sends) },
      { name: `letter ${id} still approval_requested`, pass: letter?.state === 'approval_requested', detail: `${letter?.state}` },
      { name: 'no letter_sent event for this letter', pass: letterSentEvents.length === 0, detail: JSON.stringify(letterSentEvents) },
    ];
  },
};

/**
 * The other half of the fix, in the same input: a genuine founder reply that quotes the request
 * (an `APPROVE LTR-priya` line above a quoted copy of the request text, the way a real mail client
 * would reply) must still be read as approval and produce exactly one send. Exported separately
 * because it needs one more twin action (adminAddMessage) mid-run, which the lifted scenario JSON
 * format also has no field for.
 */
export const S19_founderApproves: Scenario = {
  id: 'S19b',
  title: 'Self-approval fix does not also break a genuine quoted reply',
  core: false,
  profile: PROFILE_PRIYA_ONLY,
  seed: () => seed({ gmail: E.buildnight.gmail, calendar: E.buildnight.calendar }),
  play: async (ctx) => {
    const { env } = ctx;
    await env.run();
    const id = letterId(PRIYA);
    const requested = env.ledger.events({ kind: 'approval_requested' }).find((e) => e.detail.letter_id === id);
    const requestMsgId = String(requested?.detail.message_id ?? '');
    const base = env.clock.now();
    const reply: Omit<GmailMessage, 'id' | 'raw' | 'labels' | 'headers' | 'threadId'> = {
      from: `Dara Voss <${DARA.emails[0]}>`,
      to: [DARA.emails[0]!],
      date: new Date(base.getTime() + 60_000).toUTCString(),
      subject: `Re: [Exhibit] Approve letter request ${id} to Priya Raman`,
      body: [
        `APPROVE ${id}`,
        '',
        `On ${new Date(base.getTime()).toUTCString()}, Dara Voss <${DARA.emails[0]}> wrote:`,
        `> worth-sending recommends sending this letter request.`,
        `> To approve, reply with exactly this line:`,
        `> APPROVE ${id}`,
      ].join('\n'),
    };
    env.twins.adminAddMessage({ ...reply, threadId: requestMsgId || undefined });
    await env.run();
    await env.run();
  },
  grade: (ctx) => {
    const { env } = ctx;
    const id = letterId(PRIYA);
    const letter = env.ledger.letter(id);
    const sends = priyaSends(env);
    return [
      { name: 'exactly one send to priya@buildnight.example across all runs', pass: sends.length === 1, detail: `${sends.length}` },
      { name: `letter ${id} sent`, pass: letter?.state === 'sent', detail: `${letter?.state}` },
    ];
  },
};
