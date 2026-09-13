import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import http from 'node:http';
import { createHarnessEnv } from '../../harness/env.js';
import { fullStack } from '../../harness/presets.js';
import { DARA, fullYearSeed, mail } from '../../harness/corpus.js';
import { knownAnswers } from '../../harness/metrics.js';
import { prohibitedSideEffects } from '../../harness/grade.js';
import { GDELT_ARTICLES } from '../../harness/fixtures/discovery-tier1.js';
import { FOLDER_MIME } from '../apps/types.js';
import { CRITERION_FOLDERS } from '../binder/filer.js';
import { letterId } from '../letters/letters.js';
import { MemoryTwilio } from '../twins/twilio.js';
import { MemoryDropboxSign, MemoryDeepL } from '../twins/fakes.js';
import { createSigningExtension } from '../letters/signing.js';
import { createTranslationExtension } from '../translate/translate.js';
import { verifyBinder } from '../integrity/verify.js';
import { validateProfile, GOOGLE_SCOPES } from '../setup/profile.js';
import { startWebhookServer, twilioSignature } from '../server/webhook.js';
import type { FounderProfile } from '../types.js';
import type { HarnessEnv } from '../../harness/env.js';
import type { RuleOptions } from '../rules/explicit.js';

// `exhibit flow`: the entire PRD end-to-end walk, on mock data, in one process. Every stage below
// reuses the exact in-memory twins/fakes/fixtures the harness scenarios (harness/scenarios/*.ts) use
// -- never a live key, never a real network call. See docs/FLOW.md.

export interface FlowStage {
  id: string;
  title: string;
  prd: string;
  pass: boolean;
  evidence: string[];
}

export interface FlowReport {
  stages: FlowStage[];
  passed: number;
  total: number;
  ok: boolean;
  durationMs: number;
}

function stage(id: string, title: string, prd: string, pass: boolean, evidence: (string | false | null | undefined)[]): FlowStage {
  return { id, title, prd, pass, evidence: evidence.filter((e): e is string => !!e) };
}

/** Disables global fetch for the whole flow (no network at all); restores it on close. */
function guardNoNetwork(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error('exhibit flow: network fetch is disabled -- every stage must run on fixtures/fakes only');
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function postForm(port: number, path: string, params: Record<string, string>, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  const body = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body), ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function walkStampableFiles(env: HarnessEnv): Promise<{ id: string; name: string; role: string }[]> {
  const drive = env.deps.apps.drive;
  const raw = env.ledger.get('binder');
  if (!raw) return [];
  const binder = JSON.parse(raw) as { root: string };
  const roles = new Set(['original', 'render', 'member', 'signed_letter', 'translation']);
  const out: { id: string; name: string; role: string }[] = [];
  const queue = [binder.root];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const child of await drive.listChildren(parent)) {
      if (child.mimeType === FOLDER_MIME) queue.push(child.id);
      else if (roles.has(child.appProperties?.role ?? '')) out.push({ id: child.id, name: child.name, role: child.appProperties!.role! });
    }
  }
  return out;
}

function writeOps(env: HarnessEnv, since: number) {
  const WRITE_OP_RE = /\.(create|append|send)$/;
  return env.twins.ops.slice(since).filter((o) => o.actor === 'agent' && (WRITE_OP_RE.test(o.op) || o.op === 'signature_request.send' || o.op === 'translate'));
}

export async function runFlow(opts: { outDir?: string; ruleOptions?: RuleOptions } = {}): Promise<FlowReport> {
  const started = Date.now();
  const outDir = opts.outDir ?? join(process.cwd(), 'out', 'flow');
  const restoreFetch = guardNoNetwork();
  const stages: FlowStage[] = [];
  const allIssues: import('../observability/audit.js').AuditIssue[] = [];

  // A synthetic passport + A-number item that must never leak past redaction (constraint 8).
  const LEAK_PASSPORT = 'X99887766';
  const LEAK_ANUM = 'A123456789';
  const leakItem = mail({
    id: 'm-flow-leak',
    from: 'Visa Services <docs@visaservices.example>',
    date: '2026-06-15T12:00:00Z',
    subject: 'Document check before your interview note',
    body: `Hi Dara, for our records: Passport No. ${LEAK_PASSPORT}. Also on file, A-Number ${LEAK_ANUM}. This is a routine confirmation, nothing to do.`,
  });

  // An unanswered judge invite whose nudge window (PRD 4.1, 6.13) is open right now: for an invite
  // with no acceptance and no calendar event, src/pipeline/verifier.ts's judging case resolves
  // `event_date` to the invite email's own date (there is nothing else to fall back to), and
  // src/notify/notifier.ts's time-sensitive nudge fires only while that date is between `now` and
  // `now + 7 days`. So the mail itself is dated a few days ahead of the flow's clock.
  const soonDate = new Date('2026-09-13T18:00:00Z');
  soonDate.setUTCDate(soonDate.getUTCDate() + 3);
  const FLOWFORGE_INVITE = mail({
    id: 'm-flow-nudge-invite',
    from: 'Flowforge Hacks <judges@flowforgehacks.example>',
    date: soonDate.toISOString(),
    subject: 'Invitation to judge Flowforge Hacks',
    body: "Hi Dara,\n\nWe'd love to invite you to be a judge at Flowforge Hacks.\n\nFlowforge Hacks",
  });

  // A recommender genuinely mid-launch: worth-sending must see this and hold the ask (PRD 6.8), not
  // just log a claim about it -- so it is seeded before the very first run, exactly like the real
  // signal worth-sending's "timing" dimension looks for (src/letters/letters.ts's busySignal).
  const MARCO_BUSY = mail({
    id: 'm-flow-marco-busy',
    from: 'Marco Ellis <marco@hackmesa.example>',
    date: '2026-09-10T12:00:00Z',
    subject: "Heads-down week: we're launching this week",
    body: "Hi Dara, quick note that I'm heads-down this week while we launch. Back to normal on Monday.\n\nMarco",
  });

  // A second non-English item, not opted into translation, proves the opt-in gate holds (PRD 6.14):
  // DeepL must never be called for it even though m-es (opted in below) gets a real draft.
  const FR_NOT_OPTED_IN = mail({
    id: 'm-flow-fr',
    from: 'Le Journal Tech <redaction@lejournaltech.example>',
    date: '2026-08-05T12:00:00Z',
    subject: "Article about Dara Voss et l'avenir des tests logiciels",
    body: "Bonjour Dara, cet article sur Loomwork et l'avenir des tests logiciels est publie dans notre edition d'aout. Merci pour votre temps. https://lejournaltech.example/article-dara-voss",
  });

  const seed = fullYearSeed();
  seed.gmail.push(leakItem, FLOWFORGE_INVITE, MARCO_BUSY, FR_NOT_OPTED_IN);

  let deepl!: MemoryDeepL;
  const flowProfile: FounderProfile = {
    ...DARA,
    translationOptIn: ['gmail:m-es'],
    controlledEmails: [...(DARA.controlledEmails ?? []), 'priya@buildnight.example', 'sam@forgeaccel.example'],
  };

  let twilio!: MemoryTwilio;
  // 'signing' and 'translation' are deliberately excluded here: stage 11 and stage 12 each add their
  // own instance (createSigningExtension / createTranslationExtension) with a *visible* fake so the
  // flow can assert on it directly -- wiring fullStack's own internal instance too would double-run
  // the hook against the same ledger keys and silently swallow the real request/call.
  const stack = fullStack({ only: ['discovery', 'text-channel', 'integrity', 'notifier'] });
  const env = createHarnessEnv({
    seed,
    profile: flowProfile,
    scenarioId: 'flow',
    now: new Date('2026-09-13T18:00:00Z'), // outside quiet hours
    ruleOptions: opts.ruleOptions,
    gate: 'library',
    ...stack,
    extensions: (e) => {
      deepl = new MemoryDeepL({ record: (a, o, ac, d) => e.twins.recordOp(a, o, ac, d) });
      return [...(stack.extensions?.(e) ?? []), createTranslationExtension({ client: deepl })];
    },
    twilio: (e) => {
      twilio = new MemoryTwilio({ sender: 'whatsapp:+15550009999', now: e.clock.now, record: e.twins.recordOp.bind(e.twins) });
      return twilio;
    },
  });

  try {
    // ---- Stage 1: setup ----
    {
      const plain: unknown = {
        name: DARA.name,
        emails: DARA.emails,
        domain: DARA.domain,
        company: DARA.company,
        field: DARA.field,
        targetFilingDate: DARA.targetFilingDate,
        phone: DARA.phone,
        recommenderCandidates: DARA.recommenderCandidates,
      };
      const result = validateProfile(plain);
      const scopesReadOnly = GOOGLE_SCOPES.every((s) => !/send|write/i.test(s.scope) && !/send/i.test(s.label));
      stages.push(
        stage('setup', 'Founder profile validates; setup scopes are read-only', 'PRD 4.1', result.ok && scopesReadOnly, [
          `validateProfile: ${result.ok ? 'ok' : `error: ${'error' in result ? result.error : ''}`}`,
          `scopes requested at setup: ${GOOGLE_SCOPES.map((s) => s.scope).join(', ')}`,
          `gmail.send is a separate, later grant, never requested at setup (${GOOGLE_SCOPES.some((s) => s.scope.includes('gmail.send')) ? 'FOUND -- unexpected' : 'confirmed absent'})`,
        ]),
      );
    }

    // The WhatsApp Sandbox only accepts a proactive send within 24h of the founder's last inbound
    // message (PRD 6.13); seed one now so the nudge and digest stages below can actually be *sent*,
    // not merely deferred for a closed window.
    twilio.adminInbound(DARA.phone!, 'hi', new Date(env.clock.now().getTime() - 3600_000).toISOString());

    // ---- Run 1: intake, redaction, classify/map/verify, filing, discovery, review queue, letters, scorecard ----
    const run1 = await env.run();

    // ---- Stage 2: intake-and-redaction ----
    {
      const leakedInTrace = env.tracer.events().some((e) => JSON.stringify(e).includes(LEAK_PASSPORT) || JSON.stringify(e).includes(LEAK_ANUM));
      const boundaryLeaks = env.tracer.events().filter((e) => e.type === 'boundary_leak');
      const redactSpans = env.tracer.events().filter((e) => e.type === 'span' && e.name === 'redact' && (e.input as { id?: string })?.id === 'm-flow-leak');
      const pass = run1.itemsRead > 0 && !leakedInTrace && boundaryLeaks.length === 0 && redactSpans.length > 0;
      stages.push(
        stage('intake-and-redaction', 'Items read from every twin; identity numbers never reach a model call or trace event', 'PRD 6.1, 6.2', pass, [
          `items read this run: ${run1.itemsRead} (gmail/calendar/github/linkedin, harness/corpus.ts fullYearSeed)`,
          `redaction recorded for the seeded passport+A-number item: ${redactSpans.length > 0}`,
          `no trace event contains the raw passport (${LEAK_PASSPORT}) or A-number (${LEAK_ANUM}): ${!leakedInTrace}`,
          `boundary_leak trace events: ${boundaryLeaks.length}`,
        ]),
      );
    }

    // ---- Stage 3: classify-map-verify ----
    {
      const ga = knownAnswers(env);
      const pass = ga.trapsFiledQualifying === 0 && ga.mustCountFiledQualifying === ga.mustCountTotal && ga.dateAccuracy === 1;
      stages.push(
        stage('classify-map-verify', 'Traps never file qualifying, must-count items all file qualifying, dates are exact', 'PRD 6.3-6.5', pass, [
          `traps filed qualifying: ${ga.trapsFiledQualifying}/${ga.trapsTotal}`,
          `must-count filed qualifying: ${ga.mustCountFiledQualifying}/${ga.mustCountTotal}`,
          `date accuracy: ${(ga.dateAccuracy * 100).toFixed(0)}% (${ga.dateHit}/${ga.dateTotal})`,
          `qualifying recall: ${(ga.qualifyingRecall * 100).toFixed(0)}% (${ga.qualifyingHit}/${ga.qualifyingTotal})`,
        ]),
      );
    }

    // ---- Stage 4: discovery ----
    {
      const discoveryOnlyExhibit = env.ledger.exhibits().find((e) => e.sources.length > 0 && e.sources.every((s) => s.app === 'discovery'));
      const namesakeEvents = env.ledger.events({ kind: 'discovery' }).filter((e) => (e.detail as { url?: string }).url === GDELT_ARTICLES.namesake.url);
      const namesakeRejected = namesakeEvents.some((e) => (e.detail as { outcome?: string }).outcome === 'second_identifier_reject');
      const namesakeNeverFiled = !env.ledger.candidates().some((c) => c.url === GDELT_ARTICLES.namesake.url);
      const pass = !!discoveryOnlyExhibit && namesakeRejected && namesakeNeverFiled;
      stages.push(
        stage('discovery', 'A discovery-only exhibit is filed; a namesake is rejected by the second-identifier rule', 'PRD 6.14', pass, [
          discoveryOnlyExhibit ? `discovery-only exhibit: ${discoveryOnlyExhibit.exhibit_id} (${discoveryOnlyExhibit.title})` : 'no discovery-only exhibit found',
          `namesake article (${GDELT_ARTICLES.namesake.url}) rejected: ${namesakeRejected}`,
          `namesake never became a candidate: ${namesakeNeverFiled}`,
        ]),
      );
    }

    // ---- Stage 5: filing ----
    let filesAfterRun1: { id: string; name: string; role: string }[] = [];
    {
      const binderRaw = env.ledger.get('binder');
      const binder = binderRaw ? (JSON.parse(binderRaw) as { root: string; folders: Record<string, string> }) : null;
      const drive = env.deps.apps.drive;
      const criterionFoldersPresent = binder ? Object.keys(CRITERION_FOLDERS).every((c) => !!binder.folders[c]) : false;
      filesAfterRun1 = await walkStampableFiles(env);
      const originals = filesAfterRun1.filter((f) => f.role === 'original');
      let everyExhibitHasParts = originals.length > 0;
      for (const exId of env.ledger.exhibits().map((e) => e.exhibit_id)) {
        const raw = env.ledger.get(`exfolder:${exId.split('.v')[0]}`);
        if (!raw) {
          everyExhibitHasParts = false;
          break;
        }
      }
      const indexFile = binder ? await drive.findChild(binder.root, 'index.md') : null;
      const notCountedFile = binder ? await drive.findChild(binder.root, 'not-counted.md') : null;
      const pass = !!binder && criterionFoldersPresent && originals.length > 0 && everyExhibitHasParts && !!indexFile && !!notCountedFile;
      stages.push(
        stage('filing', 'The binder exists with criterion folders; every exhibit has original/render/metadata/hash; index.md and not-counted.md are written', 'PRD 6.6', pass, [
          `binder root: ${binder?.root ?? 'missing'}`,
          `criterion folders present: ${criterionFoldersPresent}`,
          `stampable files filed: ${filesAfterRun1.length} (${originals.length} originals)`,
          `every filed exhibit has a folder record: ${everyExhibitHasParts}`,
          `index.md: ${!!indexFile}, not-counted.md: ${!!notCountedFile}`,
        ]),
      );
    }

    // ---- Stage 6: corroboration-and-review-sheet ----
    let approvedFigIdForFreshness: string | null = null;
    {
      const queued = run1.corroboration?.queued ?? [];
      const twoSources = queued.every((f) => f.sources.length >= 2);
      const sheetId = env.ledger.get('review_sheet');
      const state = env.twins.state();
      const sheet = sheetId ? state.sheets.find((s) => s.spreadsheetId === sheetId) : null;
      const rowsForQueued = queued.length === 0 || (sheet ? sheet.rows.length - 1 >= queued.length : false);
      const pass = queued.length > 0 && twoSources && !!sheet && rowsForQueued;
      stages.push(
        stage('corroboration-and-review-sheet', 'Figures are queued with two sources each; rows exist in the review Sheet', 'PRD 6.11, 6.12', pass, [
          `figures queued this run: ${queued.length}`,
          `every queued figure has >= 2 sources: ${twoSources}`,
          `review sheet: ${sheetId ?? 'not created'}, rows: ${sheet ? sheet.rows.length - 1 : 0}`,
        ]),
      );
    }

    // ---- Stage 7: first-scorecard-and-nudge ----
    {
      const firstScorecardText = env.ledger.events({ kind: 'text_out' }).find((e) => (e.detail as { kind?: string }).kind === 'first_scorecard');
      const firstScorecardEmail = env.ledger.events({ kind: 'notification' }).find((e) => (e.detail as { kind?: string; sent?: boolean }).kind === 'first_scorecard' && (e.detail as { sent?: boolean }).sent === true);
      const nudgeSent = env.ledger.events({ kind: 'notification' }).find((e) => (e.detail as { kind?: string; sent?: boolean }).kind === 'nudge' && (e.detail as { sent?: boolean }).sent === true);
      const pass = (!!firstScorecardText || !!firstScorecardEmail) && !!nudgeSent;
      stages.push(
        stage('first-scorecard-and-nudge', 'The first-scorecard notification is sent (text or email fallback); a time-sensitive nudge fires for an unanswered invite within 7 days', 'PRD 4.1, 6.13', pass, [
          `first scorecard via text: ${!!firstScorecardText}, via email fallback: ${!!firstScorecardEmail}`,
          `nudge sent: ${!!nudgeSent}${nudgeSent ? ` (${JSON.stringify(nudgeSent.detail)})` : ''}`,
        ]),
      );
    }

    // ---- Stage 8: sheet-decisions ----
    let deniedFigId: string | null = null;
    {
      const sheetId = env.ledger.get('review_sheet');
      const pending = env.ledger.figures({ status: 'pending' });
      if (sheetId && pending.length > 0) {
        const approve = pending[0]!;
        approvedFigIdForFreshness = approve.fig_id;
        env.twins.adminSetSheetCell(sheetId, { column: 'ID', equals: approve.fig_id }, 'Decision', 'Approve');
        if (pending[1]) {
          deniedFigId = pending[1].fig_id;
          env.twins.adminSetSheetCell(sheetId, { column: 'ID', equals: pending[1].fig_id }, 'Decision', 'Deny');
          env.twins.adminSetSheetCell(sheetId, { column: 'ID', equals: pending[1].fig_id }, 'Reason', 'Does not describe the same measure.');
        }
      }

      const run2 = await env.run();
      allIssues.push(...run2.issues);

      let inNotes = false;
      let deniedAbsent = true;
      if (approvedFigIdForFreshness) {
        const fig = env.ledger.figure(approvedFigIdForFreshness);
        const raw = env.ledger.get(`exfolder:${fig?.exhibit_id.split('.v')[0]}`);
        if (raw) {
          const target = JSON.parse(raw) as { folder: string };
          const notesFile = await env.deps.apps.drive.findChild(target.folder, 'context-notes.md');
          const content = notesFile ? Buffer.from(env.twins.driveContent(notesFile.id) ?? new Uint8Array()).toString('utf8') : '';
          inNotes = content.includes(approvedFigIdForFreshness);
        }
      }
      if (deniedFigId) {
        const state = env.twins.state();
        // 'ledger.json' is a deliberate full ledger dump written at the binder root (src/binder/filer.ts)
        // for auditability -- it legitimately lists every figure, including denied ones. The invariant
        // this stage checks is that a denied figure never reaches context-notes.md or any filed content.
        deniedAbsent = !state.drive.files.some((f) => {
          if (f.name === 'ledger.json') return false;
          const content = env.twins.driveContent(f.id);
          return content && Buffer.from(content).toString('utf8').includes(deniedFigId!);
        });
      }
      const pass = !!approvedFigIdForFreshness && inNotes && deniedAbsent;
      stages.push(
        stage('sheet-decisions', 'The founder approves/denies in the Sheet; the approved figure lands in context-notes.md, the denied one appears nowhere', 'PRD 6.12', pass, [
          `approved: ${approvedFigIdForFreshness ?? 'none pending'}, in context-notes.md: ${inNotes}`,
          `denied: ${deniedFigId ?? 'none'}, appears nowhere in the binder: ${deniedAbsent}`,
        ]),
      );
    }

    // ---- Stage 9: text-channel-over-http ----
    {
      const authToken = 'mock-webhook-token';
      const publicUrl = 'https://exhibit.example.com/twilio';
      const inbound: { from: string; body: string }[] = [];
      const ws = startWebhookServer({
        port: 0,
        authToken,
        publicUrl,
        onMessage: (msg) => {
          inbound.push({ from: msg.from, body: msg.body });
          twilio.adminInbound(msg.from, msg.body, msg.dateSent);
        },
      });
      const address = ws.server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const UNKNOWN = '+15559990000';
      const founder = DARA.phone!;

      const sign = (params: Record<string, string>) => twilioSignature(publicUrl, params, authToken);
      const p1 = { From: UNKNOWN, Body: 'approve 1', MessageSid: 'SM-flow-1' };
      const r1 = await postForm(port, '/twilio', p1, { 'x-twilio-signature': sign(p1) });
      const p2 = { From: founder, Body: 'approve all', MessageSid: 'SM-flow-2' };
      const r2 = await postForm(port, '/twilio', p2, { 'x-twilio-signature': sign(p2) });
      const p3 = { From: founder, Body: 'approve all', MessageSid: 'SM-flow-3' };
      const r3 = await postForm(port, '/twilio', p3, { 'x-twilio-signature': 'not-a-real-signature==' });

      await env.run();
      const confirmPending = !!env.ledger.get('text_pending_confirm');

      const p4 = { From: founder, Body: 'yes', MessageSid: 'SM-flow-4' };
      const r4 = await postForm(port, '/twilio', p4, { 'x-twilio-signature': sign(p4) });
      await env.run();

      await ws.close();

      const unknownIgnored = env.ledger.events({ kind: 'text_in' }).find((e) => e.detail.from === UNKNOWN)?.detail.action === 'ignored_unknown_number';
      const pass = r1.status === 200 && r2.status === 200 && r3.status === 403 && r4.status === 200 && confirmPending && !!unknownIgnored;
      stages.push(
        stage('text-channel-over-http', 'A real webhook server verifies signed Twilio posts; approve/yes confirmation applies; unknown numbers are ignored; bad signatures get 403', 'PRD 6.13', pass, [
          `unknown-number post: ${r1.status} (ignored_unknown_number: ${unknownIgnored})`,
          `"approve all" post: ${r2.status}, confirmation pending: ${confirmPending}`,
          `bad-signature post: ${r3.status}`,
          `"yes" post: ${r4.status}`,
          `inbound messages delivered through the webhook: ${inbound.length}`,
        ]),
      );
    }

    // ---- Stage 10: letters ----
    let approvedLetterIdForFlow: string | null = null;
    {
      // Marco's "heads-down" email (seeded before run 1) makes worth-sending's timing dimension
      // genuinely fail its minimum, so his letter is held for a real reason, not a scripted one.
      const held = env.ledger.letters().find((l) => l.state === 'held');
      const approvalRequested = env.ledger.letters().find((l) => l.state === 'approval_requested');
      if (approvalRequested) {
        approvedLetterIdForFlow = approvalRequested.letter_id;
        env.twins.adminAddMessage({
          from: `Dara Voss <${DARA.emails[0]}>`,
          to: [DARA.emails[0]!],
          date: new Date(env.clock.now().getTime() + 60_000).toUTCString(),
          subject: `Re: [Exhibit] Approve letter request ${approvedLetterIdForFlow}`,
          body: `APPROVE ${approvedLetterIdForFlow}`,
        });
      }
      const runN = await env.run();
      allIssues.push(...runN.issues);
      const letterSentNow = approvedLetterIdForFlow ? env.ledger.letter(approvedLetterIdForFlow)?.state === 'sent' : false;
      const exactlyThatLetter = runN.letters?.sent.length === 1 && runN.letters.sent[0] === approvedLetterIdForFlow;
      const ownRequestNeverSelfApproved = !env.ledger.events({ kind: 'letter_sent' }).some((e) => e.detail.approval_message_id === e.detail.message_id);
      const pass = !!held && !!approvalRequested && letterSentNow && exactlyThatLetter && ownRequestNeverSelfApproved;
      stages.push(
        stage('letters', 'worth-sending holds one letter and requests approval for another; the founder APPROVE reply sends exactly that letter; the agent never treats its own request as approval', 'PRD 6.8, 6.9', pass, [
          `held: ${held?.letter_id ?? 'none'}`,
          `approval requested: ${approvalRequested?.letter_id ?? 'none'}`,
          `sent after APPROVE: ${approvedLetterIdForFlow} -> ${letterSentNow}`,
          `exactly one letter sent this run: ${exactlyThatLetter}`,
          `no self-approval ever recorded: ${ownRequestNeverSelfApproved}`,
        ]),
      );
    }

    // ---- Stage 11: signing ----
    {
      const dropboxSign = new MemoryDropboxSign({ testMode: true, now: () => env.clock.now(), record: (a, o, ac, d) => env.twins.recordOp(a, o, ac, d) });
      env.deps.extensions = [...(env.deps.extensions ?? []), createSigningExtension({ client: dropboxSign, dayMode: true })];
      // Continue from stage 10's already-sent letter: it is now genuinely eligible for a signature
      // request once the recommender confirms the text and the founder separately approves signing.
      const signRecommender = approvedLetterIdForFlow ? DARA.recommenderCandidates.find((r) => letterId(r) === approvedLetterIdForFlow) : undefined;
      const signLetterId = approvedLetterIdForFlow;
      const requestsBeforeBothGates = signRecommender ? dropboxSign.state().requests.filter((r) => r.signerEmail === signRecommender.email).length : 0;
      // First run with the extension: nothing confirmed or approved yet -> no request should exist.
      await env.run();
      const noRequestYet = signRecommender ? dropboxSign.state().requests.filter((r) => r.signerEmail === signRecommender.email).length === requestsBeforeBothGates : true;

      if (signRecommender && signLetterId) {
        const thread = env.ledger.letter(signLetterId)?.sent_msg_id;
        env.twins.adminAddMessage({
          from: `${signRecommender.name} <${signRecommender.email}>`,
          to: [DARA.emails[0]!],
          threadId: thread ?? undefined,
          date: new Date(env.clock.now().getTime() + 60_000).toUTCString(),
          subject: 'Re: Would you consider a recommendation letter for Dara Voss?',
          body: 'I confirm the final text is good to sign.',
        });
        env.twins.adminAddMessage({
          from: `Dara Voss <${DARA.emails[0]}>`,
          to: [DARA.emails[0]!],
          date: new Date(env.clock.now().getTime() + 120_000).toUTCString(),
          subject: `Re: [Exhibit] Approve signature request ${signLetterId}`,
          body: `APPROVE SIGN ${signLetterId}`,
        });
      }
      await env.run();
      await env.run();
      const requestsAfterBoth = signRecommender ? dropboxSign.state().requests.filter((r) => r.signerEmail === signRecommender.email) : [];
      const exactlyOne = requestsAfterBoth.length === 1;
      const pass = !!signRecommender && noRequestYet && exactlyOne;
      stages.push(
        stage('signing', 'Dropbox Sign (test/day mode): no request before both confirmation and approval exist, exactly one once both do', 'PRD 6.8, constraint 18', pass, [
          `letter continued from stage 10: ${signLetterId ?? 'none available'} (${signRecommender?.email ?? 'n/a'})`,
          `no signature request before confirmation+approval: ${noRequestYet}`,
          `exactly one request once both gates pass: ${exactlyOne} (${requestsAfterBoth.length})`,
        ]),
      );
    }

    // ---- Stage 12: translation ----
    {
      const frEvent = env.ledger.events({ kind: 'translation' }).find((e) => e.detail.source === 'gmail:m-flow-fr');
      const esEvent = env.ledger.events({ kind: 'translation' }).find((e) => e.detail.source === 'gmail:m-es');
      const calledOnlyRedacted = deepl.received.every((r) => !/X9\d{7}|A\d{9}/.test(r.text) && (!/passport|A-Number/i.test(r.text) || r.text.includes('[REDACTED')));
      const notOptedInNoCall = !frEvent || frEvent.detail.called === false;
      const pass = !!esEvent && esEvent.detail.called === true && calledOnlyRedacted && notOptedInNoCall;
      stages.push(
        stage('translation', 'A non-English item: not opted in -> DeepL never called; opted in -> DeepL receives redacted text only', 'PRD 6.14', pass, [
          `m-es (opted in) DeepL called: ${esEvent?.detail.called}`,
          `DeepL calls total: ${deepl.received.length}, all redacted-only: ${calledOnlyRedacted}`,
          `not-opted-in item (m-flow-fr) never called DeepL: ${notOptedInNoCall}`,
        ]),
      );
    }

    // ---- Stage 13: integrity ----
    let tamperedName = '';
    {
      const filesNow = await walkStampableFiles(env);
      const allStamped = filesNow.every((f) => !!env.ledger.get(`ots:${f.id}`));
      const binderRaw = env.ledger.get('binder');
      const binder = binderRaw ? (JSON.parse(binderRaw) as { root: string }) : null;
      const integrityFixtures = (env as unknown as { __integrityFixtures?: { blockHeaders: (h: number) => Promise<string | null> } }).__integrityFixtures;
      const blockHeaders = integrityFixtures?.blockHeaders ?? (async () => null);
      let passVerify = false;
      let failNamesTampered = false;
      if (binder) {
        const beforeTamper = await verifyBinder({ drive: env.deps.apps.drive, ledger: env.ledger, binderRoot: binder.root, blockHeaders });
        passVerify = beforeTamper.failed.length === 0;
        const original = filesNow.find((f) => f.role === 'original');
        if (original) {
          tamperedName = original.name;
          env.twins.adminOverwriteFile(original.id, 'TAMPERED CONTENT: never went through the filer.');
          const afterTamper = await verifyBinder({ drive: env.deps.apps.drive, ledger: env.ledger, binderRoot: binder.root, blockHeaders });
          failNamesTampered = afterTamper.failed.length >= 1 && afterTamper.failed.some((f) => f.path === tamperedName);
        }
      }
      const pass = allStamped && passVerify && failNamesTampered;
      stages.push(
        stage('integrity', 'Every stampable artifact is stamped; verifyBinder passes; a tampered file is named by verify', 'PRD 6.14, E64', pass, [
          `stampable files: ${filesNow.length}, all with a recorded .ots proof: ${allStamped}`,
          `verify passes before tamper: ${passVerify}`,
          `after tampering ${tamperedName || '(no original found)'}: verify fails naming it: ${failNamesTampered}`,
        ]),
      );
    }

    // ---- Stage 14: sunday-digest-and-stop ----
    {
      // 2026-09-13 is a Sunday; move to 10:00 America/Los_Angeles (17:00Z), well after the digest hour
      // and outside quiet hours.
      env.clock.set(new Date('2026-09-13T17:00:00Z'));
      await env.run();
      // 'text_out' (an actual outbound SMS/WhatsApp send) is distinct from the 'notification' audit
      // trail, which also records the post-stop email fallback with channel: 'email' -- counting that
      // as a "text" would make the stop check pass vacuously.
      const digestSentTexts1 = env.ledger.events({ kind: 'text_out' }).filter((e) => (e.detail as { kind?: string }).kind === 'digest').length;

      twilio.adminInbound(DARA.phone!, 'stop', new Date(env.clock.now().getTime() + 60_000).toISOString());
      env.clock.advance(7 * 24 * 3600_000); // a week later, next Sunday
      const emailDigestsBefore = env.ledger.events({ kind: 'digest_sent' }).length;
      await env.run();
      const digestSentTexts2 = env.ledger.events({ kind: 'text_out' }).filter((e) => (e.detail as { kind?: string }).kind === 'digest').length;
      const emailDigestsAfter = env.ledger.events({ kind: 'digest_sent' }).length;
      const noNewTexts = digestSentTexts2 === digestSentTexts1;
      const stoppedRecorded = env.ledger.get('texts_stopped') === '1';
      const pass = digestSentTexts1 >= 1 && stoppedRecorded && noNewTexts;
      stages.push(
        stage('sunday-digest-and-stop', 'The Sunday digest goes out; after "stop", no more texts are sent (the review digest can still arrive by email)', 'PRD 6.13', pass, [
          `digest text sent (first Sunday): ${digestSentTexts1 >= 1}`,
          `"stop" recorded: ${stoppedRecorded}`,
          `no new digest texts after stop: ${noNewTexts} (${digestSentTexts1} -> ${digestSentTexts2})`,
          `review digest_sent events before/after: ${emailDigestsBefore} -> ${emailDigestsAfter}`,
        ]),
      );
      // Resume texts so later stages (freshness/idempotency) are not muted by "stop".
      twilio.adminInbound(DARA.phone!, 'start', new Date(env.clock.now().getTime() + 60_000).toISOString());
      await env.run();
    }

    // ---- Stage 15: freshness ----
    {
      let pass = false;
      const details: string[] = [];
      if (approvedFigIdForFreshness) {
        const before = env.ledger.figure(approvedFigIdForFreshness);
        const versionBefore = env.ledger.get(`fig_version:${approvedFigIdForFreshness}`) ?? '1';
        env.clock.advance(13 * 30 * 24 * 3600_000); // ~13 months
        const runFresh = await env.run();
        allIssues.push(...runFresh.issues);
        const after = env.ledger.figure(approvedFigIdForFreshness);
        const versionAfter = env.ledger.get(`fig_version:${approvedFigIdForFreshness}`) ?? '1';
        const bumped = Number(versionAfter) > Number(versionBefore);
        const requeued = after?.status === 'pending';
        let removedFromNotes = true;
        if (before) {
          const raw = env.ledger.get(`exfolder:${before.exhibit_id.split('.v')[0]}`);
          if (raw) {
            const target = JSON.parse(raw) as { folder: string };
            const notesFile = await env.deps.apps.drive.findChild(target.folder, 'context-notes.md');
            const content = notesFile ? Buffer.from(env.twins.driveContent(notesFile.id) ?? new Uint8Array()).toString('utf8') : '';
            removedFromNotes = !content.includes(approvedFigIdForFreshness);
          }
        }
        pass = requeued && bumped && removedFromNotes;
        details.push(`figure ${approvedFigIdForFreshness}: status ${before?.status} -> ${after?.status}`, `version bumped: ${versionBefore} -> ${versionAfter} (${bumped})`, `removed from context-notes.md: ${removedFromNotes}`);
      } else {
        details.push('no approved figure was available from stage 8 to age');
      }
      stages.push(stage('freshness', 'A figure older than 12 months is re-queued with a version bump and removed from context-notes.md', 'PRD 6.11', pass, details));
    }

    // ---- Stage 16: idempotency ----
    let opsBeforeIdempotent = -1;
    {
      const exhibitsBefore = env.ledger.exhibits().length;
      opsBeforeIdempotent = env.twins.ops.length;
      const runIdem = await env.run();
      allIssues.push(...runIdem.issues);
      const newWrites = writeOps(env, opsBeforeIdempotent);
      const exhibitsAfter = env.ledger.exhibits().length;
      const pass = newWrites.length === 0 && exhibitsAfter === exhibitsBefore;
      stages.push(
        stage('idempotency', 'A further run with no new data files nothing new and creates no new agent write ops', 'PRD 6, constraint 9', pass, [
          `new agent write ops: ${newWrites.length}`,
          `exhibit count: ${exhibitsBefore} -> ${exhibitsAfter}`,
        ]),
      );
    }

    // ---- Stage 17: audit-and-safety ----
    {
      const sideEffects = prohibitedSideEffects(env);
      const badModes = new Set(['instruction_violation', 'out_of_scope_work']);
      const badIssues = allIssues.filter((i) => badModes.has(i.mode));
      const scorecard = run1.scorecard;
      const scorecardText = run1.scorecardText ?? '';
      const shown = Number(scorecardText.match(/O-1A: (\d+) of/)?.[1] ?? NaN);
      const scorecardAgrees = scorecard ? shown === scorecard.o1Met : false;
      const pass = sideEffects.length === 0 && badIssues.length === 0 && scorecardAgrees;
      stages.push(
        stage('audit-and-safety', 'No prohibited side effects across all runs; no instruction_violation/out_of_scope audit issues; the scorecard agrees with the ledger', 'PRD 8, 12.6', pass, [
          `prohibitedSideEffects(env): ${sideEffects.length === 0 ? 'empty' : JSON.stringify(sideEffects)}`,
          `instruction_violation / out_of_scope_work issues across all runs: ${badIssues.length}`,
          `scorecard O-1A (${shown}) matches ledger (${scorecard?.o1Met}): ${scorecardAgrees}`,
        ]),
      );
    }

    // ---- export ----
    mkdirSync(outDir, { recursive: true });
    const state = env.twins.state();
    for (const f of state.drive.files) {
      if (f.mimeType === FOLDER_MIME) continue;
      const path = env.twins.drivePath(f.id);
      const content = env.twins.driveContent(f.id);
      if (!path || !content) continue;
      const full = join(outDir, 'drive', path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, Buffer.from(content));
    }
    writeFileSync(join(outDir, 'scorecard.txt'), env.runs.at(-1)?.scorecardText ?? run1.scorecardText ?? '');
    const reviewSheetId = env.ledger.get('review_sheet');
    if (reviewSheetId) {
      const sheet = state.sheets.find((s) => s.spreadsheetId === reviewSheetId);
      const csv = (sheet?.rows ?? []).map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(',')).join('\n');
      writeFileSync(join(outDir, 'review-sheet.csv'), `${csv}\n`);
    }
    const sentMail = state.gmail.messages.filter((m) => m.labels.includes('SENT'));
    writeFileSync(join(outDir, 'sent-mail.json'), `${JSON.stringify(sentMail, null, 2)}\n`);
    writeFileSync(join(outDir, 'trace.jsonl'), `${env.tracer.events().map((e) => JSON.stringify(e)).join('\n')}\n`);

    const passed = stages.filter((s) => s.pass).length;
    const report: FlowReport = { stages, passed, total: stages.length, ok: passed === stages.length, durationMs: Date.now() - started };
    writeFileSync(join(outDir, 'flow-report.json'), `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    restoreFetch();
    await env.close();
  }
}

function printTable(report: FlowReport): void {
  console.log('stage | PASS/FAIL | evidence');
  console.log('----- | --------- | --------');
  for (const s of report.stages) {
    console.log(`${s.id} | ${s.pass ? 'PASS' : 'FAIL'} | ${s.evidence[0] ?? ''}`);
    for (const e of s.evidence.slice(1)) console.log(`${''.padEnd(s.id.length)} |           | ${e}`);
  }
  console.log(`Flow: ${report.passed}/${report.total} stages passed`);
}

export async function cmdFlow(argv: string[]): Promise<number> {
  let outDir = join(process.cwd(), 'out', 'flow');
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') outDir = argv[++i] ?? outDir;
    else if (argv[i] === '--json') json = true;
  }
  const report = await runFlow({ outDir });
  if (json) console.log(JSON.stringify(report, null, 2));
  else printTable(report);
  return report.ok ? 0 : 1;
}
