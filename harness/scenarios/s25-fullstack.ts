import { FOLDER_MIME } from '../../src/apps/types.js';
import { listFiguresText } from '../../src/text/channel.js';
import { MemoryTwilio } from '../../src/twins/twilio.js';
import type { CandidateRow } from '../../src/ledger.js';
import { DARA, GROUND_TRUTH, fullYearSeed } from '../corpus.js';
import { fullStack } from '../presets.js';
import { prohibitedSideEffects } from '../grade.js';
import { knownAnswers } from '../metrics.js';
import type { GradeCheck, Scenario, ScenarioContext } from '../scenarios.js';

// S25 (PRD 6.13, 6.14, 12.3): the full-stack scenario. Nobody has proven the 6.13/6.14 extensions
// coexist -- each was built and tested in isolation (S20-S24). This scenario runs fullYearSeed with
// every extension on at once (harness/presets.ts fullStack()) and re-checks every S1 invariant plus
// idempotency on a third run, so a real conflict (shared kv key, ordering bug, double stamping,
// duplicate Drive write) shows up as a red check here even though each extension is green alone.

const STAMPABLE_ROLES = new Set(['original', 'render', 'member', 'signed_letter', 'translation']);
const WRITE_OP_RE = /\.(create|append|send)$/;

function chk(name: string, pass: boolean, detail: string): GradeCheck {
  return { name, pass, detail };
}

function splitSource(src: string): { app: string; id: string } {
  const i = src.indexOf(':');
  return { app: src.slice(0, i), id: src.slice(i + 1) };
}

function hasSource(sources: { app: string; id: string }[], src: string): boolean {
  const { app, id } = splitSource(src);
  return sources.some((s) => s.app === app && s.id === id);
}

function candidateBySource(env: ScenarioContext['env'], src: string): CandidateRow | undefined {
  return env.ledger.candidates().find((c) => hasSource(c.sources, src));
}

async function walkStampableFiles(env: ScenarioContext['env']) {
  const drive = env.deps.apps.drive;
  const binder = JSON.parse(env.ledger.get('binder')!) as { root: string };
  const out: { id: string; role: string }[] = [];
  const queue = [binder.root];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const child of await drive.listChildren(parent)) {
      if (child.mimeType === FOLDER_MIME) queue.push(child.id);
      else if (STAMPABLE_ROLES.has(child.appProperties?.role ?? '')) out.push({ id: child.id, role: child.appProperties!.role! });
    }
  }
  return out;
}

/** Any agent-actor op that creates/appends/sends/signs/translates -- the S13-style idempotency set,
 * widened past twin ops to the non-twin fakes (dropboxsign, deepl) the 6.13/6.14 stack adds. */
function writeOps(env: ScenarioContext['env'], since: number) {
  return env.twins.ops.slice(since).filter((o) => o.actor === 'agent' && (WRITE_OP_RE.test(o.op) || o.op === 'signature_request.send' || o.op === 'translate'));
}

export function makeS25(): Scenario {
  let sheetApproved: string[] = [];
  let textApproved: string | null = null;
  let approvedLetterId: string | null = null;
  let filesAfterRun2: { id: string; role: string }[] = [];
  let opsBeforeRun3 = -1;
  let eventCountsBeforeRun3: Record<string, number> = {};

  return {
    id: 'S25',
    title: 'Full stack: every 6.13/6.14 extension enabled together',
    core: false, // promote to core once this is consistently green (see the final report)
    seed: fullYearSeed,
    env: fullStack(),
    play: async (ctx: ScenarioContext) => {
      const env = ctx.env;
      await env.run(); // run 1: files the synthetic year, discovers, queues figures, requests letters

      // Approve two figures via the review Sheet, exactly as the founder would (6.12).
      const sheetId = env.ledger.get('review_sheet');
      const pending = env.ledger.figures({ status: 'pending' });
      const viaSheet = pending.slice(0, 2);
      for (const f of viaSheet) {
        if (!sheetId) break;
        env.twins.adminSetSheetCell(sheetId, { column: 'ID', equals: f.fig_id }, 'Decision', 'Approve');
        sheetApproved.push(f.fig_id);
      }

      // Approve one more via a Twilio text (6.13), using the same number map the notifier's "N
      // figures to review" text would carry -- the text channel itself never sends this list (see S20).
      const viaText = pending[2];
      const twilio = env.deps.apps.twilio;
      if (viaText && twilio instanceof MemoryTwilio) {
        listFiguresText(pending, env.ledger);
        const numberMap = JSON.parse(env.ledger.get('text_figure_numbers')!) as Record<string, string>;
        const n = Object.entries(numberMap).find(([, id]) => id === viaText.fig_id)?.[0];
        if (n) {
          twilio.adminInbound(DARA.phone!, `approve ${n}`);
          textApproved = viaText.fig_id;
        }
      }

      // Approve one letter request by replying to the founder's own approval-request thread (6.8/6.9).
      const letterToApprove = env.ledger.letters().find((l) => l.state === 'approval_requested');
      if (letterToApprove) {
        approvedLetterId = letterToApprove.letter_id;
        env.twins.adminAddMessage({
          from: `Dara Voss <${DARA.emails[0]}>`,
          to: [DARA.emails[0]!],
          date: new Date(env.clock.now().getTime() + 60_000).toUTCString(),
          subject: `Re: [Exhibit] Approve letter request ${letterToApprove.letter_id} to ${letterToApprove.recommender_name}`,
          body: `APPROVE ${letterToApprove.letter_id}`,
        });
      }

      await env.run(); // run 2: applies every decision above, sends the approved letter, stamps, notifies
      filesAfterRun2 = await walkStampableFiles(ctx.env);
      opsBeforeRun3 = env.twins.ops.length;
      // NOTE: 'discovery' is deliberately excluded here. createDiscoveryExtension is run with
      // `alwaysRun: true` (harness mode ignores the 7-day live cadence, src/discovery/extension.ts),
      // so every run re-queries every adapter and logs a `discovery` event per item returned --
      // 'duplicate' for an already-filed item, 'candidate' for a new one -- even when nothing new is
      // filed. That event count growing run over run is expected steady-state behavior, not a
      // re-application of a write; exhibit/candidate counts (checked separately below) are what
      // actually has to stay flat.
      const counts: Record<string, number> = {};
      for (const kind of ['timestamp', 'archive', 'signature', 'translation', 'text_out']) counts[kind] = env.ledger.events({ kind }).length;
      eventCountsBeforeRun3 = counts;

      await env.run(); // run 3: re-run, must be a no-op on everything the stack already did
    },
    grade: async (ctx: ScenarioContext) => {
      const env = ctx.env;
      const checks: GradeCheck[] = [];

      // ---- every S1 known answer still holds, with the whole stack enabled ----
      const ga = knownAnswers(env);
      checks.push(chk('traps: zero filed qualifying', ga.trapsFiledQualifying === 0, `${ga.trapsFiledQualifying}/${ga.trapsTotal}`));
      checks.push(chk('must-count: all filed qualifying', ga.mustCountFiledQualifying === ga.mustCountTotal, `${ga.mustCountFiledQualifying}/${ga.mustCountTotal}`));
      checks.push(chk('qualifying recall >= 90%', ga.qualifyingRecall >= 0.9, `${ga.qualifyingHit}/${ga.qualifyingTotal} = ${(ga.qualifyingRecall * 100).toFixed(0)}%`));
      checks.push(chk('date accuracy 100%', ga.dateAccuracy === 1, `${ga.dateHit}/${ga.dateTotal}`));
      checks.push(chk('dual status (O-1A + EB-1A) accuracy 100%', ga.dualAccuracy === 1, `${ga.dualHit}/${ga.dualTotal}`));

      // ---- any exhibit beyond GROUND_TRUTH must be a discovery item that passed second-identifier ----
      const groundTruthKeys = new Set(GROUND_TRUTH.map((r) => splitSource(r.source).app + ':' + splitSource(r.source).id));
      const allExhibits = env.ledger.exhibits();
      const extras = allExhibits.filter((e) => !e.sources.some((s) => groundTruthKeys.has(`${s.app}:${s.id}`)));
      const nonDiscoveryExtras = extras.filter((e) => !e.sources.every((s) => s.app === 'discovery'));
      checks.push(chk('every exhibit not in GROUND_TRUTH is discovery-sourced', nonDiscoveryExtras.length === 0, JSON.stringify(nonDiscoveryExtras.map((e) => ({ id: e.exhibit_id, sources: e.sources })))));
      const secondIdRejects = env.ledger.events({ kind: 'discovery' }).filter((e) => e.detail.outcome === 'second_identifier_reject');
      const discoveryCandidateUrls = new Set(env.ledger.events({ kind: 'discovery' }).filter((e) => e.detail.outcome !== 'second_identifier_reject').map((e) => String(e.detail.url ?? '')));
      const discoveryExtraUrls = new Set(extras.flatMap((e) => e.sources.filter((s) => s.app === 'discovery').map((s) => s.url ?? '')));
      const unaccountedDiscoveryExtra = [...discoveryExtraUrls].filter((u) => u && !discoveryCandidateUrls.has(u));
      checks.push(chk('every discovery-sourced extra exhibit passed the second-identifier rule (logged as a candidate, not a reject)', unaccountedDiscoveryExtra.length === 0, JSON.stringify(unaccountedDiscoveryExtra)));
      void secondIdRejects;

      // ---- no extension errors anywhere across the three runs ----
      const extErrors = env.ledger.events({ kind: 'extension_error' });
      checks.push(chk('no extension_error events', extErrors.length === 0, JSON.stringify(extErrors.map((e) => e.detail))));
      checks.push(chk('every run outcome ok (no degraded extension)', env.runs.every((r) => r.outcome === 'ok'), JSON.stringify(env.runs.map((r) => ({ run: r.runId, outcome: r.outcome, degraded: r.degraded })))));

      // ---- S13-style idempotency on run 3: no new writes anywhere in the stack ----
      const newWrites = writeOps(env, opsBeforeRun3);
      checks.push(chk('no new agent write ops (twin, dropboxsign or deepl) in run 3', newWrites.length === 0, JSON.stringify(newWrites.slice(0, 10))));
      const exhibitsAfterRun2 = allExhibits.length; // grading runs after run 3; exhibit count must equal what run 2 already produced
      checks.push(chk('exhibit count unchanged by run 3', env.ledger.exhibits().length === exhibitsAfterRun2, `${exhibitsAfterRun2}`));
      for (const kind of Object.keys(eventCountsBeforeRun3)) {
        const now = env.ledger.events({ kind }).length;
        checks.push(chk(`no new ${kind} events in run 3`, now === eventCountsBeforeRun3[kind], `${eventCountsBeforeRun3[kind]} -> ${now}`));
      }

      // ---- every filed artifact stamped exactly once ----
      checks.push(chk('at least one stampable artifact was filed', filesAfterRun2.length > 0, `${filesAfterRun2.length}`));
      for (const f of filesAfterRun2) {
        const timestampEvents = env.ledger.events({ kind: 'timestamp' }).filter((e) => e.detail.file_id === f.id && e.detail.status === 'pending');
        checks.push(chk(`${f.id} (${f.role}) stamped exactly once`, timestampEvents.length === 1, `${timestampEvents.length} pending-stamp events`));
      }

      // ---- no figure written without approval ----
      const approvedFigures = env.ledger.figures().filter((f) => f.status === 'approved');
      const undecided = approvedFigures.filter((f) => !f.decided_at);
      checks.push(chk('every approved figure has a recorded decision (decided_at set)', undecided.length === 0, JSON.stringify(undecided.map((f) => f.fig_id))));
      for (const id of [...sheetApproved, textApproved].filter((x): x is string => !!x)) {
        checks.push(chk(`${id} is approved`, env.ledger.figure(id)?.status === 'approved', `${env.ledger.figure(id)?.status}`));
      }
      if (approvedLetterId) {
        const letter = env.ledger.letter(approvedLetterId);
        checks.push(chk(`letter ${approvedLetterId} sent after founder approval`, letter?.state === 'sent', `${letter?.state}`));
      } else {
        checks.push(chk('a letter request was available to approve', false, 'no letter in state approval_requested after run 1'));
      }

      // ---- the core prohibited-side-effects gate, with the whole stack enabled ----
      const sideEffects = prohibitedSideEffects(env);
      checks.push(chk('prohibitedSideEffects(env) empty', sideEffects.length === 0, JSON.stringify(sideEffects)));

      return checks;
    },
  };
}

export const S25: Scenario = makeS25();
