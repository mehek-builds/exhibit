import { describe, expect, it } from 'vitest';
import { createHarnessEnv } from '../harness/env.js';
import { seed, NOW } from '../harness/corpus.js';
import { failingApp } from '../harness/faults.js';
import { ensureBinder } from '../src/binder/filer.js';
import type { BinderIds, FilerDeps } from '../src/binder/filer.js';
import { requeueStaleFigures } from '../src/research/freshness.js';
import { applyDecisions, figVersion, queueFigures, rowFor, REVIEW_HEADERS } from '../src/review/queue.js';
import type { ReviewDeps } from '../src/review/queue.js';
import type { FigureRow, FigureSource } from '../src/ledger.js';
import { PROFILE } from './helpers.js';

// End-to-end coverage (via createHarnessEnv) for the freshness/review interaction: a figure that
// goes stale must require a brand-new founder Approve read AFTER it was re-queued -- the old
// Sheet row's Approve from before staleness must never count again (constraint 13, PRD 6.11).

async function setup() {
  const env = createHarnessEnv({ seed: seed({}), now: NOW });
  const trace = (await env.tracer.run({ name: 'test', runId: 'r1', input: {} }, async (c) => c)).result;
  const filerDeps: FilerDeps = { drive: env.deps.apps.drive, ledger: env.ledger, trace, profile: PROFILE, runId: 'r1', now: NOW };
  const binder: BinderIds = await ensureBinder(filerDeps);
  const reviewDeps: ReviewDeps = { apps: env.deps.apps, ledger: env.ledger, trace, profile: PROFILE, binder, runId: 'r1', now: NOW };
  return { env, binder, reviewDeps };
}

async function makeExhibitFolder(env: ReturnType<typeof createHarnessEnv>, binder: BinderIds, exhibitId: string) {
  const exFolder = await env.deps.apps.drive.createFolder(binder.folders['3']!, exhibitId);
  const sourcesFolder = await env.deps.apps.drive.createFolder(exFolder.id, 'sources');
  const entry = { folder: exFolder.id, sources: sourcesFolder.id };
  env.ledger.set(`exfolder:${exhibitId}`, JSON.stringify(entry));
  return entry;
}

async function stageSnapshot(env: ReturnType<typeof createHarnessEnv>, binder: BinderIds, name: string, body: string) {
  const file = await env.deps.apps.drive.createFile({ parentId: binder.staging, name, mimeType: 'text/html', content: body });
  return { id: file.id, sha256: file.sha256! };
}

function approvedFigureRow(p: { fig_id: string; exhibit_id: string; as_of: string; sources: FigureSource[] }): FigureRow {
  return {
    fig_id: p.fig_id,
    exhibit_id: p.exhibit_id,
    criterion: 3,
    measure: 'monthly readers',
    value: 1_200_000,
    unit: 'monthly readers',
    as_of: p.as_of,
    sources: p.sources,
    label: 'independently_confirmed',
    note: 'Devtools Weekly reaches about 1,200,000 monthly readers, per its media kit and AMR.',
    status: 'approved',
    fingerprint: `fp-${p.fig_id}`,
    detail: null,
    queued_at: '2026-01-01T00:00:00.000Z',
    decided_at: '2026-01-02T00:00:00.000Z',
    decision_reason: 'looks good',
    run_id: 'r1',
    trace_id: null,
  };
}

describe('freshness + review sheet: a stale approved figure needs a fresh founder decision', () => {
  it('is NOT re-approved by the old row, in the same run or the next, and only takes effect after a genuine new Approve', async () => {
    const { env, binder, reviewDeps } = await setup();
    const exId = 'EX-3-101';
    const folders = await makeExhibitFolder(env, binder, exId);
    const snap = await stageSnapshot(env, binder, 'snap.html', '<html>Devtools Weekly reaches 1,200,000 monthly readers.</html>');
    const source: FigureSource = { kind: 'primary', url: 'https://devtoolsweekly.example/media-kit', publisher: 'Devtools Weekly', sentence: 'reaches 1,200,000', snapshot_html_id: snap.id, snapshot_pdf_id: null, snapshot_sha256: snap.sha256, as_of: '2025-08-01' };
    // 13 months old as of NOW (2026-09-13); decided long before it went stale.
    const pendingRow = approvedFigureRow({ fig_id: 'FIG-101', exhibit_id: exId, as_of: '2025-08-01', sources: [source] });
    pendingRow.status = 'pending';
    pendingRow.decided_at = null;
    pendingRow.decision_reason = null;
    env.ledger.insertFigure(pendingRow);
    // Queue the original row (as it would have been queued back when the figure was first found),
    // then simulate the founder's original Approve that landed on that exact row.
    await queueFigures([pendingRow], reviewDeps);
    const sheetId = env.ledger.get('review_sheet')!;
    // The founder's real Approve on this row, months ago -- back-dated so the figure is both
    // 13 months old and was decided before it went stale (matches how a real approval ages).
    env.twins.adminSetSheetCell(sheetId, { column: 'ID', equals: 'FIG-101' }, 'Decision', 'Approve');
    env.twins.adminSetSheetCell(sheetId, { column: 'ID', equals: 'FIG-101' }, 'Reason', 'looks good');
    env.ledger.updateFigure('FIG-101', { status: 'approved', decided_at: '2026-01-02T00:00:00.000Z', decision_reason: 'looks good' });

    // Run N: freshness flags it stale, applyDecisions must not re-approve it from the old row.
    const stale = requeueStaleFigures(env.ledger, NOW, { runId: 'r1', traceId: null });
    expect(stale.staleFigIds).toEqual(['FIG-101']);
    const summaryN = await applyDecisions(reviewDeps);
    expect(summaryN.approved).not.toContain('FIG-101');
    expect(summaryN.pending).toContain('FIG-101');
    expect(env.ledger.figure('FIG-101')!.status).toBe('pending');

    // Check 3: not written to context notes while pending.
    const notesAfterN = await env.deps.apps.drive.findChild(folders.folder, 'context-notes.md');
    if (notesAfterN) {
      const text = Buffer.from(await env.deps.apps.drive.readFile(notesAfterN.id)).toString('utf8');
      expect(text).not.toContain('FIG-101');
    }

    // queueFigures now appends a fresh row for the re-queued (pending) figure.
    await queueFigures([env.ledger.figure('FIG-101')!], reviewDeps);

    // Run N+1 (no new founder action yet): the newest row is blank, so it must stay pending, not
    // re-approved from the old row that is still sitting earlier in the sheet.
    const summaryN1 = await applyDecisions(reviewDeps);
    expect(summaryN1.approved).not.toContain('FIG-101');
    expect(env.ledger.figure('FIG-101')!.status).toBe('pending');
    const notesAfterN1 = await env.deps.apps.drive.findChild(folders.folder, 'context-notes.md');
    if (notesAfterN1) {
      const text = Buffer.from(await env.deps.apps.drive.readFile(notesAfterN1.id)).toString('utf8');
      expect(text).not.toContain('FIG-101');
    }

    // Now the founder genuinely approves it again, on the newest row. The in-memory twin's
    // adminSetSheetCell helper only targets the first row matching a given ID, which can't reach a
    // second row for the same fig_id -- so append a fresh row directly (as the founder editing the
    // Decision/Reason cells on the row queueFigures just appended would produce) rather than
    // routing through that helper.
    const freshRow = rowFor(env.ledger.figure('FIG-101')!, figVersion(env.ledger, 'FIG-101'));
    freshRow[REVIEW_HEADERS.indexOf('Decision')] = 'Approve';
    freshRow[REVIEW_HEADERS.indexOf('Reason')] = 'confirmed current';
    await env.deps.apps.sheets.appendRows(sheetId, [freshRow]);
    const summaryApprove = await applyDecisions(reviewDeps);
    expect(summaryApprove.approved).toContain('FIG-101');
    expect(env.ledger.figure('FIG-101')!.status).toBe('approved');
    const notesAfterApproval = await env.deps.apps.drive.findChild(folders.folder, 'context-notes.md');
    expect(notesAfterApproval).not.toBeNull();
    const notesText = Buffer.from(await env.deps.apps.drive.readFile(notesAfterApproval!.id)).toString('utf8');
    expect(notesText).toContain('FIG-101');

    // Later runs: it stays approved and is not re-flagged as stale again (decided_at is now after
    // the figure was flagged stale, so it will not loop every run).
    const decidedAt = env.ledger.figure('FIG-101')!.decided_at!;
    const laterNow = new Date(NOW.getTime());
    const staleAgain = requeueStaleFigures(env.ledger, laterNow, { runId: 'r2', traceId: null });
    expect(staleAgain.staleFigIds).toEqual([]);
    expect(env.ledger.figure('FIG-101')!.status).toBe('approved');
    expect(env.ledger.figure('FIG-101')!.decided_at).toBe(decidedAt);

    await env.close();
  });

  it('an 11-month figure is untouched by freshness and its sheet row is never re-read as stale', async () => {
    const { env, binder, reviewDeps } = await setup();
    const exId = 'EX-3-102';
    await makeExhibitFolder(env, binder, exId);
    const snap = await stageSnapshot(env, binder, 'snap2.html', '<html>Some figure.</html>');
    const source: FigureSource = { kind: 'primary', url: 'https://x.example/page', publisher: 'X', sentence: 'a sentence', snapshot_html_id: snap.id, snapshot_pdf_id: null, snapshot_sha256: snap.sha256, as_of: '2025-10-20' };
    const row = approvedFigureRow({ fig_id: 'FIG-102', exhibit_id: exId, as_of: '2025-10-20', sources: [source] });
    env.ledger.insertFigure(row);

    const stale = requeueStaleFigures(env.ledger, NOW, { runId: 'r1', traceId: null });
    expect(stale.staleFigIds).toEqual([]);
    expect(env.ledger.figure('FIG-102')!.status).toBe('approved');

    const summary = await applyDecisions(reviewDeps);
    expect(summary.approved).toEqual([]);
    expect(summary.pending).toEqual([]);
    expect(env.ledger.figure('FIG-102')!.status).toBe('approved');

    await env.close();
  });
});

/** Reorders a Sheet's data rows in-place, the way a founder's manual sort would. Reaches into
 * MemoryTwins' internal store -- there is no public reorder API, because a real Sheets API user
 * wouldn't need one either; the founder just drags rows around in the UI. */
function reorderSheetRows(env: ReturnType<typeof createHarnessEnv>, spreadsheetId: string, cmp: (a: string[], b: string[]) => number): void {
  const store = (env.twins as unknown as { sheets: Map<string, { rows: string[][] }> }).sheets;
  const s = store.get(spreadsheetId)!;
  const [header, ...body] = s.rows;
  s.rows = [header!, ...body.sort(cmp)];
}

describe('review queue: row identity is a figure version, not row order (constraint 13 redesign)', () => {
  async function staleApprovedSetup(figId: string, exId: string) {
    const { env, binder, reviewDeps } = await setup();
    const folders = await makeExhibitFolder(env, binder, exId);
    const snap = await stageSnapshot(env, binder, 'snap.html', '<html>Devtools Weekly reaches 1,200,000 monthly readers.</html>');
    const source: FigureSource = { kind: 'primary', url: 'https://devtoolsweekly.example/media-kit', publisher: 'Devtools Weekly', sentence: 'reaches 1,200,000', snapshot_html_id: snap.id, snapshot_pdf_id: null, snapshot_sha256: snap.sha256, as_of: '2025-08-01' };
    const pendingRow = approvedFigureRow({ fig_id: figId, exhibit_id: exId, as_of: '2025-08-01', sources: [source] });
    pendingRow.status = 'pending';
    pendingRow.decided_at = null;
    pendingRow.decision_reason = null;
    env.ledger.insertFigure(pendingRow);
    await queueFigures([pendingRow], reviewDeps);
    const sheetId = env.ledger.get('review_sheet')!;
    env.twins.adminSetSheetCell(sheetId, { column: 'ID', equals: figId }, 'Decision', 'Approve');
    env.twins.adminSetSheetCell(sheetId, { column: 'ID', equals: figId }, 'Reason', 'looks good');
    env.ledger.updateFigure(figId, { status: 'approved', decided_at: '2026-01-02T00:00:00.000Z', decision_reason: 'looks good' });
    const stale = requeueStaleFigures(env.ledger, NOW, { runId: 'r1', traceId: null });
    expect(stale.staleFigIds).toEqual([figId]);
    expect(env.ledger.get(`fig_version:${figId}`)).toBe('2');
    return { env, binder, reviewDeps, folders, sheetId };
  }

  it('a failed Sheet append in the re-queue run still leaves the old row unable to re-approve, this run or the next', async () => {
    const { env, reviewDeps, sheetId } = await staleApprovedSetup('FIG-301', 'EX-3-301');

    const summaryN = await applyDecisions(reviewDeps);
    expect(summaryN.pending).toContain('FIG-301');

    // The re-queue's append to the Sheet fails (network outage, quota, whatever).
    const failingDeps: ReviewDeps = { ...reviewDeps, apps: failingApp(env.deps.apps, 'sheets', 'unavailable') };
    const { degraded } = await queueFigures([env.ledger.figure('FIG-301')!], failingDeps);
    expect(degraded).toContain('sheets');
    // No v2 row exists in the Sheet at all.
    const rows = await env.deps.apps.sheets.readRows(sheetId);
    expect(rows.some((r) => r[0] === 'FIG-301 (v2)')).toBe(false);

    // Next run: still nothing but the stale v1 row (with its old Approve) exists. It must not count.
    const summaryN1 = await applyDecisions(reviewDeps);
    expect(summaryN1.approved).not.toContain('FIG-301');
    expect(summaryN1.pending).toContain('FIG-301');
    expect(env.ledger.figure('FIG-301')!.status).toBe('pending');

    await env.close();
  });

  it('a founder-reordered Sheet (old row last) still does not re-approve from the old row', async () => {
    const { env, reviewDeps, sheetId } = await staleApprovedSetup('FIG-302', 'EX-3-302');
    await applyDecisions(reviewDeps); // consumes the stale v1 Approve as "pending", no-op otherwise
    await queueFigures([env.ledger.figure('FIG-302')!], reviewDeps); // appends the blank v2 row

    // Founder sorts the sheet; the old (v1, Approve) row ends up after the new (v2, blank) row.
    reorderSheetRows(env, sheetId, (a, b) => (a[0] === 'FIG-302 (v2)' ? -1 : b[0] === 'FIG-302 (v2)' ? 1 : 0));
    const rows = await env.deps.apps.sheets.readRows(sheetId);
    const ids = rows.slice(1).map((r) => r[0]);
    expect(ids.indexOf('FIG-302 (v2)')).toBeLessThan(ids.indexOf('FIG-302'));

    const summary = await applyDecisions(reviewDeps);
    expect(summary.approved).not.toContain('FIG-302');
    expect(summary.pending).toContain('FIG-302');
    expect(env.ledger.figure('FIG-302')!.status).toBe('pending');

    await env.close();
  });

  it('a genuine Approve on the v2 row is approved and stays approved', async () => {
    const { env, binder, reviewDeps, folders, sheetId } = await staleApprovedSetup('FIG-303', 'EX-3-303');
    await applyDecisions(reviewDeps);
    await queueFigures([env.ledger.figure('FIG-303')!], reviewDeps);
    env.twins.adminSetSheetCell(sheetId, { column: 'ID', equals: 'FIG-303 (v2)' }, 'Decision', 'Approve');
    env.twins.adminSetSheetCell(sheetId, { column: 'ID', equals: 'FIG-303 (v2)' }, 'Reason', 'confirmed current');

    const summary = await applyDecisions(reviewDeps);
    expect(summary.approved).toContain('FIG-303');
    expect(env.ledger.figure('FIG-303')!.status).toBe('approved');
    const notes = await env.deps.apps.drive.findChild(folders.folder, 'context-notes.md');
    expect(notes).not.toBeNull();
    const text = Buffer.from(await env.deps.apps.drive.readFile(notes!.id)).toString('utf8');
    expect(text).toContain('FIG-303');

    await env.close();
    void binder;
  });

  it('a Deny on the v2 row is respected', async () => {
    const { env, reviewDeps, sheetId } = await staleApprovedSetup('FIG-304', 'EX-3-304');
    await applyDecisions(reviewDeps);
    await queueFigures([env.ledger.figure('FIG-304')!], reviewDeps);
    env.twins.adminSetSheetCell(sheetId, { column: 'ID', equals: 'FIG-304 (v2)' }, 'Decision', 'Deny');
    env.twins.adminSetSheetCell(sheetId, { column: 'ID', equals: 'FIG-304 (v2)' }, 'Reason', 'no longer accurate');

    const summary = await applyDecisions(reviewDeps);
    expect(summary.denied).toContain('FIG-304');
    expect(env.ledger.figure('FIG-304')!.status).toBe('denied');

    await env.close();
  });

  it('a Deny left on the stale v1 row does not revive or kill the v2 figure', async () => {
    const { env, reviewDeps, sheetId } = await staleApprovedSetup('FIG-305', 'EX-3-305');
    // Founder (mistakenly, or before noticing the re-queue) writes Deny on the OLD row.
    env.twins.adminSetSheetCell(sheetId, { column: 'ID', equals: 'FIG-305' }, 'Decision', 'Deny');
    env.twins.adminSetSheetCell(sheetId, { column: 'ID', equals: 'FIG-305' }, 'Reason', 'stale deny attempt' );

    const summary = await applyDecisions(reviewDeps);
    expect(summary.denied).not.toContain('FIG-305');
    expect(summary.approved).not.toContain('FIG-305');
    expect(summary.pending).toContain('FIG-305');
    expect(env.ledger.figure('FIG-305')!.status).toBe('pending');

    await env.close();
  });

  it('legacy unversioned rows (no "(vN)" suffix) still work as v1', async () => {
    const { env, binder, reviewDeps } = await setup();
    const exId = 'EX-3-306';
    const folders = await makeExhibitFolder(env, binder, exId);
    const snap = await stageSnapshot(env, binder, 'snap.html', '<html>Devtools Weekly reaches 1,200,000 monthly readers.</html>');
    const source: FigureSource = { kind: 'primary', url: 'https://devtoolsweekly.example/media-kit', publisher: 'Devtools Weekly', sentence: 'reaches 1,200,000', snapshot_html_id: snap.id, snapshot_pdf_id: null, snapshot_sha256: snap.sha256, as_of: '2025-08-01' };
    const pendingRow = approvedFigureRow({ fig_id: 'FIG-306', exhibit_id: exId, as_of: '2025-08-01', sources: [source] });
    pendingRow.status = 'pending';
    pendingRow.decided_at = null;
    pendingRow.decision_reason = null;
    env.ledger.insertFigure(pendingRow);
    expect(env.ledger.get('fig_version:FIG-306')).toBeNull(); // never gone stale: no version key at all
    await queueFigures([pendingRow], reviewDeps);
    const sheetId = env.ledger.get('review_sheet')!;
    const rows = await env.deps.apps.sheets.readRows(sheetId);
    expect(rows.some((r) => r[0] === 'FIG-306')).toBe(true); // bare ID, no "(v1)" suffix written

    env.twins.adminSetSheetCell(sheetId, { column: 'ID', equals: 'FIG-306' }, 'Decision', 'Approve');
    env.twins.adminSetSheetCell(sheetId, { column: 'ID', equals: 'FIG-306' }, 'Reason', 'looks good' );
    const summary = await applyDecisions(reviewDeps);
    expect(summary.approved).toContain('FIG-306');
    expect(env.ledger.figure('FIG-306')!.status).toBe('approved');
    const notes = await env.deps.apps.drive.findChild(folders.folder, 'context-notes.md');
    expect(notes).not.toBeNull();

    await env.close();
  });
});
