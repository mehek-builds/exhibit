import { FOLDER_MIME } from '../../src/apps/types.js';
import { FixtureTransport } from '../../src/integrations/types.js';
import { createIntegrityExtension } from '../../src/integrity/extension.js';
import { verifyBinder } from '../../src/integrity/verify.js';
import type { GradeCheck, Scenario, ScenarioContext } from '../scenarios.js';
import { prohibitedSideEffects } from '../grade.js';
import { fullYearSeed } from '../corpus.js';
import { createIntegrityFixtures } from '../fixtures/integrity.js';
import type { IntegrityFixtures } from '../fixtures/integrity.js';

// S22: Integrity (PRD 12.3). Files everything from the full synthetic year, upgrades every pending
// OpenTimestamps proof, archives one approved figure's public sources, tampers with one filed
// original after stamping, then runs `verifyBinder` directly and grades its output plus the twin and
// ledger end state -- never the agent's own claims.

function chk(name: string, pass: boolean, detail: string): GradeCheck {
  return { name, pass, detail };
}

const STAMPABLE_ROLES = new Set(['original', 'render', 'member', 'signed_letter', 'translation']);

async function walkStampableFiles(env: ScenarioContext['env']) {
  const drive = env.deps.apps.drive;
  const binder = JSON.parse(env.ledger.get('binder')!) as { root: string };
  const out: { id: string; name: string; role: string }[] = [];
  const queue = [binder.root];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const child of await drive.listChildren(parent)) {
      if (child.mimeType === FOLDER_MIME) queue.push(child.id);
      else if (STAMPABLE_ROLES.has(child.appProperties?.role ?? '')) out.push({ id: child.id, name: child.name, role: child.appProperties!.role! });
    }
  }
  return out;
}

/** Builds a fresh S22 scenario. A function (not a plain object) so re-running the matrix 3 times gets 3 independent closures, never shared mutable state across attempts. */
export function makeS22(): Scenario {
  let fixtures: IntegrityFixtures;
  let transport: FixtureTransport;
  let tamperedFileId = '';
  let tamperedFileName = '';
  let approvedFigId: string | null = null;
  let filesAfterRun1: { id: string; name: string; role: string }[] = [];

  return {
    id: 'S22',
    title: 'Integrity: OpenTimestamps and Internet Archive',
    core: true,
    seed: fullYearSeed,
    play: async (ctx: ScenarioContext) => {
      const { env } = ctx;
      fixtures = createIntegrityFixtures();
      transport = new FixtureTransport(fixtures.fixtures);
      env.deps.extensions = [
        ...(env.deps.extensions ?? []),
        createIntegrityExtension({ transport, archiveKeys: { accessKey: 'test-access', secretKey: 'test-secret' }, blockHeaders: fixtures.blockHeaders }),
      ];

      await env.run(); // stamps every artifact filed this run
      filesAfterRun1 = await walkStampableFiles(env);

      // Approve one pending figure through the review sheet's admin surface, exactly as the founder would (6.12).
      const sheetId = env.ledger.get('review_sheet');
      const pending = env.ledger.figures({ status: 'pending' });
      if (sheetId && pending.length > 0) {
        approvedFigId = pending[0]!.fig_id;
        env.twins.adminSetSheetCell(sheetId, { column: 'ID', equals: approvedFigId }, 'Decision', 'Approve');
      }

      env.clock.advance(6 * 60 * 60 * 1000); // pretend a few hours passed (the nightly job runs on every run regardless)
      fixtures.markUpgraded(); // the calendars' Bitcoin transactions have now confirmed
      await env.run(); // upgrades every pending proof; applies the approval; archives its sources

      // Tamper with one filed original after stamping (E64), recorded as an admin op, never the agent's.
      const original = filesAfterRun1.find((f) => f.role === 'original');
      if (original) {
        tamperedFileId = original.id;
        tamperedFileName = original.name;
        env.twins.adminOverwriteFile(tamperedFileId, 'TAMPERED CONTENT: this byte sequence never went through the filer.');
      }
    },
    grade: async (ctx: ScenarioContext) => {
      const { env } = ctx;
      const checks: GradeCheck[] = [];
      const binder = JSON.parse(env.ledger.get('binder')!) as { root: string };

      checks.push(chk('at least one stampable artifact was filed', filesAfterRun1.length > 0, `${filesAfterRun1.length}`));
      for (const f of filesAfterRun1) {
        const raw = env.ledger.get(`ots:${f.id}`);
        checks.push(chk(`${f.name} (${f.role}) has a recorded .ots proof`, !!raw, raw ? 'present' : 'missing'));
      }

      const result = await verifyBinder({ drive: env.deps.apps.drive, ledger: env.ledger, binderRoot: binder.root, blockHeaders: fixtures.blockHeaders });
      checks.push(chk('verify checked every stampable file', result.files_checked.length === filesAfterRun1.length, `${result.files_checked.length} vs ${filesAfterRun1.length}`));
      checks.push(
        chk(
          'verify passes on every untouched file, confirmed after upgrade',
          result.passed.length === filesAfterRun1.length - (tamperedFileId ? 1 : 0),
          `passed=${result.passed.length}, pending=${result.pending.length}, failed=${JSON.stringify(result.failed)}`,
        ),
      );
      checks.push(chk('verify fails naming exactly the tampered file', result.failed.length === 1 && result.failed[0]!.path === tamperedFileName, JSON.stringify(result.failed)));
      checks.push(chk('nothing left pending after the upgrade run', result.pending.length === 0, `${result.pending.length}`));

      // Approved public sources have archive URLs, or a recorded retry (E65).
      if (approvedFigId) {
        const fig = env.ledger.figure(approvedFigId);
        checks.push(chk(`approved figure ${approvedFigId} is approved`, fig?.status === 'approved', `${fig?.status}`));
        const archiveEvents = env.ledger.events({ kind: 'archive' }).filter((e) => e.detail.fig_id === approvedFigId);
        checks.push(chk(`${approvedFigId}: an archive attempt was recorded for every source`, archiveEvents.length >= (fig?.sources.length ?? 1), `${archiveEvents.length} vs ${fig?.sources.length}`));
        checks.push(chk(`${approvedFigId}: every source has an archive URL or a recorded retry reason`, archiveEvents.every((e) => !!e.detail.archive_url || !!e.detail.reason), JSON.stringify(archiveEvents.map((e) => e.detail))));
      } else {
        checks.push(chk('a figure was available to approve', false, 'no pending figures after run 1'));
      }

      // OpenTimestamps received only 64-hex digests (constraint 17); never file bytes.
      const digestReqs = transport.requests.filter((r) => r.method === 'POST' && /\/digest$/.test(r.url));
      // The real calendar protocol posts the raw 32-byte digest (docs/integrations/OPENTIMESTAMPS.md).
      const badDigests = digestReqs.filter((r) => !(r.body instanceof Uint8Array) || r.body.byteLength !== 32);
      checks.push(chk('OpenTimestamps calendars received only 32-byte digests', digestReqs.length > 0 && badDigests.length === 0, `${digestReqs.length} requests, ${badDigests.length} not a bare 32-byte digest`));

      const sideEffects = prohibitedSideEffects(env);
      checks.push(chk('no prohibited side effects', sideEffects.length === 0, JSON.stringify(sideEffects)));

      return checks;
    },
  };
}

export const S22: Scenario = makeS22();
