import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHarnessEnv, graph } from '../harness/env.js';
import { fullYearSeed, DARA } from '../harness/corpus.js';
import type { FigureRow } from './ledger.js';
import { affected } from './rules/graph.js';

// The two-minute demo (PRD section 14), fully offline on in-memory twins: run the full synthetic
// year with every available 6.13/6.14 extension wired in (fixture transports only, no real
// network), act as the founder for one review cycle, run again, exercise the text channel, the
// integrity check and the letters flow, then export everything shown on screen to disk. Every
// module below is optional: if it is not present (another agent's work in progress), the step is
// skipped with a clear line rather than crashing the demo.

function log(line = ''): void {
  console.log(line);
}

function skip(mod: string, err?: unknown): void {
  log(`  [skipped: ${mod} not available${err ? ` — ${String(err instanceof Error ? err.message : err)}` : ''}]`);
}

function printScorecardHeadline(text: string | null): void {
  if (!text) {
    log('  (no scorecard text yet)');
    return;
  }
  const o1 = text.match(/O-1A: \d+ of 8[^\n]*/)?.[0];
  const eb1 = text.match(/EB-1A: \d+ of 10[^\n]*/)?.[0];
  const next = text.match(/Next action: [^\n]*/)?.[0];
  if (o1) log(`  ${o1}`);
  if (eb1) log(`  ${eb1}`);
  if (next) log(`  ${next}`);
}

function printNotCounted(text: string | null): void {
  if (!text) return;
  const m = text.match(/Not counted, by reason:\n([\s\S]*?)(\n\n|$)/);
  if (m) log(`  ${m[1]!.trim().split('\n').join('\n  ')}`);
}

export function latestEvalSummary(evalPath: string): string {
  if (!existsSync(evalPath)) return 'run eval';
  try {
    const evalReport = JSON.parse(readFileSync(evalPath, 'utf8')) as {
      backend?: string;
      passRate?: number;
      pass?: number;
      total?: number;
      attempts?: { passed?: boolean }[];
    };
    const backend = evalReport.backend ?? 'unknown';
    if (evalReport.attempts?.length) {
      const passed = evalReport.attempts.filter((attempt) => attempt.passed === true).length;
      return `${passed}/${evalReport.attempts.length} (${((passed / evalReport.attempts.length) * 100).toFixed(0)}%, backend=${backend})`;
    }
    if (typeof evalReport.passRate === 'number') return `${(evalReport.passRate * 100).toFixed(0)}% (backend=${backend})`;
    if (typeof evalReport.pass === 'number' && typeof evalReport.total === 'number' && evalReport.total > 0) {
      return `${evalReport.pass}/${evalReport.total} (backend=${backend})`;
    }
    return 'run eval';
  } catch {
    return 'run eval';
  }
}

export async function runDemo(outDir: string): Promise<void> {
  // 18:00 UTC = 11:00 America/Los_Angeles, outside the founder's default quiet hours (22:00-08:00
  // Pacific), so the phone-style notifications below are not silently deferred by the clock alone.
  const env = createHarnessEnv({ seed: fullYearSeed(), scenarioId: 'demo', gate: 'mcp', now: new Date('2026-09-13T18:00:00Z') });
  const extraSteps: string[] = [];
  try {
    log('=== Exhibit demo (PRD section 14) ===');
    log('Founder: Dara Voss (fictional; synthetic year only)');
    log('');

    // ---- Step 1: wire every available 6.13/6.14 extension, fixture transports only ----
    let twilio: import('./apps/types.js').TwilioApi | null = null;
    try {
      const { MemoryTwilio } = await import('./twins/twilio.js');
      twilio = new MemoryTwilio({ sender: 'whatsapp:+15550009999', now: env.clock.now, record: env.twins.recordOp.bind(env.twins) });
      env.deps.apps.twilio = twilio;
    } catch (err) {
      skip('src/twins/twilio.ts (Twilio fake)', err);
    }

    let textChannelWired = false;
    try {
      const { createTextChannel } = await import('./text/channel.js');
      const { HeuristicCommandParser } = await import('./text/commands.js');
      if (twilio) {
        env.deps.extensions = [...(env.deps.extensions ?? []), createTextChannel({ parser: new HeuristicCommandParser() })];
        textChannelWired = true;
      } else {
        skip('src/text/channel.ts (no Twilio fake to carry it)');
      }
    } catch (err) {
      skip('src/text/channel.ts or src/text/commands.ts', err);
    }

    try {
      const { createNotifier } = await import('./notify/notifier.js');
      env.deps.extensions = [...(env.deps.extensions ?? []), createNotifier()];
    } catch (err) {
      skip('src/notify/notifier.ts (phone-style scorecard notification)', err);
    }

    let discoveryWired = false;
    try {
      const { createDiscoveryExtension } = await import('./discovery/extension.js');
      const { createGdeltAdapter } = await import('./integrations/gdelt.js');
      const { FixtureTransport } = await import('./integrations/types.js');
      const { DISCOVERY_TIER1_FIXTURES } = await import('../harness/fixtures/discovery-tier1.js');
      const transport = new FixtureTransport(DISCOVERY_TIER1_FIXTURES);
      const gdelt = createGdeltAdapter({ transport });
      env.deps.extensions = [...(env.deps.extensions ?? []), createDiscoveryExtension({ adapters: [gdelt], alwaysRun: true, transportKind: 'fixture' })];
      discoveryWired = true;
    } catch (err) {
      skip('src/discovery/extension.ts, src/integrations/gdelt.ts or harness/fixtures/discovery-tier1.ts', err);
    }

    try {
      const { createStructuredResearch } = await import('./research/structured.js');
      const { createBlsAdapter } = await import('./integrations/bls.js');
      const { FixtureTransport } = await import('./integrations/types.js');
      const { VERIFIER_API_FIXTURES } = await import('../harness/fixtures/verifier-apis.js');
      const transport = new FixtureTransport(VERIFIER_API_FIXTURES);
      env.deps.structured = createStructuredResearch({ adapters: [createBlsAdapter({ transport, registrationKey: 'demo-fixture-key' })] });
    } catch (err) {
      skip('src/research/structured.ts, src/integrations/bls.ts or harness/fixtures/verifier-apis.ts', err);
    }

    let integrityWired = false;
    try {
      const { createIntegrityExtension } = await import('./integrity/extension.js');
      const { FixtureTransport } = await import('./integrations/types.js');
      const { createIntegrityFixtures } = await import('../harness/fixtures/integrity.js');
      const fixtures = createIntegrityFixtures();
      const transport = new FixtureTransport(fixtures.fixtures);
      env.deps.extensions = [...(env.deps.extensions ?? []), createIntegrityExtension({ transport, archiveKeys: { accessKey: 'demo-access', secretKey: 'demo-secret' }, blockHeaders: fixtures.blockHeaders })];
      (env as unknown as { __integrityFixtures: typeof fixtures }).__integrityFixtures = fixtures;
      integrityWired = true;
    } catch (err) {
      skip('src/integrity/extension.ts, src/integrity/verify.ts or harness/fixtures/integrity.ts', err);
    }

    try {
      const { createSigningExtension } = await import('./letters/signing.js');
      const { MemoryDropboxSign } = await import('./twins/fakes.js');
      const fake = new MemoryDropboxSign({ testMode: true, now: () => env.clock.now(), record: env.twins.recordOp.bind(env.twins) });
      env.deps.extensions = [...(env.deps.extensions ?? []), createSigningExtension({ client: fake, dayMode: true })];
    } catch (err) {
      skip('src/letters/signing.ts or src/twins/fakes.ts (letter signing)', err);
    }

    // PRD 14 (1:20): one recommender is mid-launch, so worth-sending should hold that ask truthfully.
    env.twins.adminAddMessage({
      from: 'Marco Ellis <marco@hackmesa.example>',
      to: [DARA.emails[0]!],
      date: new Date('2026-09-10T16:00:00Z').toUTCString(),
      subject: "Heads-down week: we're launching this week",
      body: "Hi Dara, quick note that I'm heads-down this week while we launch. Back to normal on Monday.\n\nMarco",
    });

    log('--- Run 1 ---');
    const run1 = await env.run();
    log(`Exhibits filed: ${run1.filed.length} (${run1.filed.join(', ') || 'none'})`);
    log('Scorecard:');
    printScorecardHeadline(run1.scorecardText);
    log('Not counted:');
    printNotCounted(run1.scorecardText);
    const queued1 = run1.corroboration?.queued ?? [];
    log(`Figures queued: ${queued1.length}`);
    for (const f of queued1 as FigureRow[]) {
      log(`  ${f.fig_id} (${f.exhibit_id}) ${f.measure}: ${f.value} ${f.unit} — ${f.label ?? 'unlabeled'}, sources: ${f.sources.map((s) => s.publisher).join(' + ')}`);
    }
    log(`Letters: drafted ${run1.letters?.drafted.length ?? 0}, held ${run1.letters?.held.length ?? 0}, awaiting approval ${run1.letters?.approvalRequested.length ?? 0}, sent ${run1.letters?.sent.length ?? 0}`);
    for (const h of run1.letters?.held ?? []) log(`  held ${h.letter_id}: ${h.reasons[0] ?? 'no reason recorded'}`);
    for (const id of run1.letters?.approvalRequested ?? []) log(`  approval requested: ${id}`);

    // ---- Step 3: the first scorecard, exactly as the phone would show it ----
    log('');
    log('--- Step 3: the first scorecard, as the phone shows it ---');
    const firstScorecardEvent = env.ledger.events({ kind: 'notification' }).find((e) => (e.detail as { kind?: string }).kind === 'first_scorecard');
    const textOut1 = env.ledger.events({ kind: 'text_out' }).find((e) => (e.detail as { kind?: string }).kind === 'first_scorecard');
    if (textOut1) {
      log(`  "${(textOut1.detail as { body?: string }).body}"`);
    } else if (firstScorecardEvent) {
      const d = firstScorecardEvent.detail as { decision?: string; reasons?: string[] };
      log(`  (notifier decision: ${d.decision ?? 'unknown'}${d.reasons?.length ? ` — ${d.reasons.join(', ')}` : ''}; no text sent yet, so the literal phone text is not available this run)`);
    } else {
      skip('src/notify/notifier.ts (no first_scorecard notification produced)');
    }

    // ---- GDELT: the article never in her inbox ----
    log('');
    log('--- Discovery: an article GDELT found that was never in her inbox ---');
    if (discoveryWired) {
      const discovered = env.ledger.events({ kind: 'discovery' }).filter((e) => (e.detail as { outcome?: string }).outcome !== 'second_identifier_reject');
      const newArticle = env.ledger.candidates().find((c) => c.sources.some((s) => `${s.app}:${s.id}`.startsWith('discovery:gdelt:')) && !c.sources.some((s) => s.app === 'gmail'));
      if (newArticle) {
        log(`  "${newArticle.title}" (${newArticle.url}) — found by GDELT only, not in Gmail`);
      } else {
        log(`  (no GDELT-only article surfaced this run; ${discovered.length} discovery event(s) recorded)`);
      }
    } else {
      skip('src/discovery/extension.ts or src/integrations/gdelt.ts');
    }

    // ---- BLS salary benchmark waiting in the review queue ----
    log('');
    log('--- #8 salary benchmark waiting in the review queue (synthetic fixture value) ---');
    const wageFig = env.ledger.figures().find((f) => f.measure === '90th-percentile annual wage');
    if (wageFig) {
      log(`  ${wageFig.fig_id}: ${wageFig.value} ${wageFig.unit} (SYNTHETIC fixture, not a published BLS figure) — status ${wageFig.status}`);
    } else {
      skip('src/research/structured.ts / src/integrations/bls.ts (no #8 wage figure produced)');
    }

    // Act as the founder: approve the first two pending figures, deny the third with a reason.
    const sheetId = env.ledger.get('review_sheet');
    const pending = env.ledger.figures({ status: 'pending' });
    let approvedIds: string[] = [];
    let deniedId: string | null = null;
    if (sheetId && pending.length) {
      const [f1, f2, f3] = pending;
      if (f1) {
        env.twins.adminSetSheetCell(sheetId, { column: 'ID', equals: f1.fig_id }, 'Decision', 'Approve');
        approvedIds.push(f1.fig_id);
      }
      if (f2) {
        env.twins.adminSetSheetCell(sheetId, { column: 'ID', equals: f2.fig_id }, 'Decision', 'Approve');
        approvedIds.push(f2.fig_id);
      }
      if (f3) {
        env.twins.adminSetSheetCell(sheetId, { column: 'ID', equals: f3.fig_id }, 'Decision', 'Deny');
        env.twins.adminSetSheetCell(sheetId, { column: 'ID', equals: f3.fig_id }, 'Reason', 'Figure does not clearly describe the same measure as the exhibit.');
        deniedId = f3.fig_id;
      }
      log('');
      log(`Founder approves ${approvedIds.join(', ') || 'none'}; denies ${deniedId ?? 'none'}.`);
    }

    // ---- Step 4: inbound text "approve 1. deny 2, old rate" applied by the text channel ----
    log('');
    log('--- Text channel: inbound "approve 1. deny 2, old rate" ---');
    let textApprovedFig: string | null = null;
    let textDeniedFig: string | null = null;
    if (textChannelWired && twilio) {
      const { listFiguresText } = await import('./text/channel.js');
      const stillPending = env.ledger.figures({ status: 'pending' });
      if (stillPending.length >= 2) {
        listFiguresText(stillPending, env.ledger);
        const numberMap = JSON.parse(env.ledger.get('text_figure_numbers') ?? '{}') as Record<string, string>;
        textApprovedFig = numberMap['1'] ?? null;
        textDeniedFig = numberMap['2'] ?? null;
        const founder = DARA.phone!;
        (twilio as unknown as { adminInbound(from: string, body: string): void }).adminInbound(founder, 'approve 1. deny 2, old rate');
        await env.run();
        const f1 = textApprovedFig ? env.ledger.figure(textApprovedFig) : null;
        const f2 = textDeniedFig ? env.ledger.figure(textDeniedFig) : null;
        log(`  #1 (${textApprovedFig}) -> ${f1?.status ?? 'unknown'}`);
        log(`  #2 (${textDeniedFig}) -> ${f2?.status ?? 'unknown'} (reason: ${f2?.decision_reason ?? 'n/a'})`);
      } else {
        log('  (fewer than two figures pending at this point; nothing to text about)');
      }
    } else {
      skip('src/text/channel.ts, src/text/commands.ts or src/twins/twilio.ts');
    }

    // Reply APPROVE for the first held-for-approval letter.
    const firstLetterId = run1.letters?.approvalRequested[0] ?? null;
    if (firstLetterId) {
      const dara = env.profile.emails[0]!;
      const approveDate = new Date(env.clock.now().getTime() + 60_000).toUTCString();
      env.twins.adminAddMessage({ from: dara, to: [dara], date: approveDate, subject: `Re: [Exhibit] Approve letter request ${firstLetterId}`, body: `APPROVE ${firstLetterId}` });
      log('');
      log(`Founder replies APPROVE ${firstLetterId}.`);
    }

    env.clock.advance(3_600_000);
    log('');
    log('--- Run 2 (one hour later) ---');
    const run2 = await env.run();
    log(`Exhibits filed this run: ${run2.filed.length} (${run2.filed.join(', ') || 'none'})`);
    log('Scorecard:');
    printScorecardHeadline(run2.scorecardText);
    for (const id of approvedIds) {
      const fig = env.ledger.figure(id);
      log(`  ${id}: ${fig?.status === 'approved' ? 'written to context-notes.md' : `not written (status ${fig?.status})`}`);
    }
    if (deniedId) {
      const fig = env.ledger.figure(deniedId);
      log(`  ${deniedId}: ${fig?.status === 'denied' ? 'appears nowhere in the binder (denied)' : `status ${fig?.status}`}`);
    }
    log(`Letters sent this run: ${run2.letters?.sent.length ?? 0} (${run2.letters?.sent.join(', ') || 'none'})`);

    // ---- Step 5: one letter held, one sent after APPROVE ----
    log('');
    log('--- Letters: one held by worth-sending, one sent after approval ---');
    const heldAny = [...(run1.letters?.held ?? []), ...(run2.letters?.held ?? [])][0];
    if (heldAny) log(`  held: ${heldAny.letter_id} — ${heldAny.reasons[0] ?? 'no reason recorded'}`);
    else log('  (no letter held in this run)');
    const sentAny = run2.letters?.sent[0] ?? run1.letters?.sent[0];
    if (sentAny) log(`  sent (after APPROVE): ${sentAny}`);
    else log('  (no letter sent in this run)');

    // ---- Step 6: integrity — stamp, upgrade, tamper, verify ----
    log('');
    log('--- Integrity: stamp, upgrade, tamper, verifyBinder ---');
    if (integrityWired) {
      try {
        const { verifyBinder } = await import('./integrity/verify.js');
        const { FOLDER_MIME } = await import('./apps/types.js');
        const binder = JSON.parse(env.ledger.get('binder') ?? '{}') as { root?: string };
        const drive = env.deps.apps.drive;
        if (binder.root) {
          const stampable: { id: string; name: string; role: string }[] = [];
          const queue = [binder.root];
          const roles = new Set(['original', 'render', 'member', 'signed_letter', 'translation']);
          while (queue.length) {
            const parent = queue.shift()!;
            for (const child of await drive.listChildren(parent)) {
              if (child.mimeType === FOLDER_MIME) queue.push(child.id);
              else if (roles.has(child.appProperties?.role ?? '')) stampable.push({ id: child.id, name: child.name, role: child.appProperties!.role! });
            }
          }
          const original = stampable.find((f) => f.role === 'original');
          const fixtures = (env as unknown as { __integrityFixtures?: { fixtures: unknown; blockHeaders: (height: number) => Promise<string | null>; markUpgraded(): void } }).__integrityFixtures;
          env.clock.advance(6 * 60 * 60 * 1000);
          fixtures?.markUpgraded();
          if (original) {
            env.twins.adminOverwriteFile(original.id, 'TAMPERED CONTENT: this byte sequence never went through the filer.');
          }
          await env.run(); // upgrades pending proofs
          const result = await verifyBinder({ drive, ledger: env.ledger, binderRoot: binder.root, blockHeaders: fixtures?.blockHeaders ?? (async () => null) });
          log(`  stamped: ${stampable.length}, verify passed: ${result.passed.length}, pending: ${result.pending.length}, failed: ${result.failed.length}`);
          if (original) {
            const caught = result.failed.find((f) => f.path === original.name);
            log(`  tampered file: ${original.name} — ${caught ? `caught by name (${caught.path})` : 'NOT CAUGHT'}`);
          }
        } else {
          log('  (no binder root in ledger yet)');
        }
      } catch (err) {
        skip('src/integrity/verify.ts', err);
      }
    } else {
      skip('src/integrity/extension.ts, src/integrity/verify.ts or harness/fixtures/integrity.ts');
    }

    // ---- export everything shown on screen to disk ----
    mkdirSync(outDir, { recursive: true });
    const driveDir = join(outDir, 'drive');
    const state = env.twins.state();
    for (const f of state.drive.files) {
      if (f.mimeType === 'application/vnd.google-apps.folder') continue;
      const path = env.twins.drivePath(f.id);
      const content = env.twins.driveContent(f.id);
      if (!path || !content) continue;
      const full = join(driveDir, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, Buffer.from(content));
    }

    const integrityFixtures = (env as unknown as {
      __integrityFixtures?: { blockHeaders: (height: number) => Promise<string | null> };
    }).__integrityFixtures;
    if (integrityFixtures) {
      const { decodeOts } = await import('./integrity/ots.js');
      const roots: Record<string, string> = {};
      const stampableRoles = new Set(['original', 'render', 'member', 'signed_letter', 'translation']);
      const artifacts = state.drive.files
        .filter((file) => stampableRoles.has(file.appProperties?.role ?? ''))
        .map((file) => env.twins.drivePath(file.id))
        .filter((path): path is string => Boolean(path?.startsWith('Exhibit binder/')))
        .map((path) => path.slice('Exhibit binder/'.length))
        .sort();
      for (const file of state.drive.files) {
        if (!file.name.endsWith('.ots')) continue;
        const content = env.twins.driveContent(file.id);
        if (!content) continue;
        const proof = decodeOts(content);
        for (const path of proof.paths) {
          if (path.attestation.kind !== 'bitcoin') continue;
          const root = await integrityFixtures.blockHeaders(path.attestation.height);
          if (root) roots[String(path.attestation.height)] = root;
        }
      }
      writeFileSync(
        join(outDir, 'integrity-chain.json'),
        `${JSON.stringify({ kind: 'synthetic-fixture', roots, artifacts }, null, 2)}\n`,
      );
    }
    writeFileSync(join(outDir, 'scorecard.txt'), run2.scorecardText ?? run1.scorecardText ?? '');

    const reviewSheetId = env.ledger.get('review_sheet');
    if (reviewSheetId) {
      const sheet = state.sheets.find((s) => s.spreadsheetId === reviewSheetId);
      const csv = (sheet?.rows ?? []).map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(',')).join('\n');
      writeFileSync(join(outDir, 'review-sheet.csv'), `${csv}\n`);
    }

    const sentMail = state.gmail.messages.filter((m) => m.labels.includes('SENT'));
    writeFileSync(join(outDir, 'sent-mail.json'), `${JSON.stringify(sentMail, null, 2)}\n`);
    writeFileSync(join(outDir, 'trace.jsonl'), `${env.tracer.events().map((e) => JSON.stringify(e)).join('\n')}\n`);
    writeFileSync(join(outDir, 'ledger.json'), `${JSON.stringify(env.ledger.exportJson(), null, 2)}\n`);
    const allIssues = [...run1.issues, ...run2.issues];
    writeFileSync(join(outDir, 'audit.json'), `${JSON.stringify(allIssues, null, 2)}\n`);

    log('');
    log(`Exported to ${outDir}: drive/, integrity-chain.json, scorecard.txt, review-sheet.csv, sent-mail.json, trace.jsonl, ledger.json, audit.json`);
    if (extraSteps.length) log(extraSteps.join('\n'));

    // ---- Step 7: proof-loop line, computed from real data ----
    const a = affected(graph(), ['decisions-5-5']);
    const evalPath = join(process.cwd(), 'reports', 'eval-latest.json');
    const evalLine = latestEvalSummary(evalPath);
    log('');
    log(`Today's rule: accelerator acceptance counts under #1 and #2 (5.5). The dependents check over the prompt graph found ${a.prompts.length} prompt(s) depend on it (${a.prompts.join(', ') || 'none'}), exercised by scenarios ${a.scenarios.join(', ') || 'none'}. Latest scenario pass rate (reports/eval-latest.json): ${evalLine}. This demo run itself found ${allIssues.length} audit issue(s) across both runs.`);
  } finally {
    await env.close();
  }
}
