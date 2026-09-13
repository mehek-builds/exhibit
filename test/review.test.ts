import { describe, expect, it } from 'vitest';
import { applyDecisions, figureCell, queueFigures, REVIEW_HEADERS } from '../src/review/queue.js';
import type { ReviewDeps } from '../src/review/queue.js';
import { ensureBinder } from '../src/binder/filer.js';
import type { BinderIds, FilerDeps } from '../src/binder/filer.js';
import { Ledger } from '../src/ledger.js';
import type { FigureRow, FigureSource } from '../src/ledger.js';
import { LocalTracer } from '../src/observability/tracer.js';
import { MemoryTwins } from '../src/twins/memory.js';
import { sha256 } from '../src/util.js';
import { NOW, seed } from '../harness/corpus.js';
import { PROFILE } from './helpers.js';

async function setup(): Promise<{ twins: MemoryTwins; ledger: Ledger; binder: BinderIds; reviewDeps: ReviewDeps }> {
  const twins = new MemoryTwins(seed({}), { now: () => NOW });
  const ledger = new Ledger(':memory:');
  const tracer = new LocalTracer(null);
  const trace = (await tracer.run({ name: 'test', runId: 'r1', input: {} }, async (c) => c)).result;
  const filerDeps: FilerDeps = { drive: twins.apps.drive, ledger, trace, profile: PROFILE, runId: 'r1', now: NOW };
  const binder = await ensureBinder(filerDeps);
  const reviewDeps: ReviewDeps = { apps: twins.apps, ledger, trace, profile: PROFILE, binder, runId: 'r1', now: NOW };
  return { twins, ledger, binder, reviewDeps };
}

async function makeExhibitFolder(twins: MemoryTwins, ledger: Ledger, binder: BinderIds, exhibitId: string): Promise<{ folder: string; sources: string }> {
  const exFolder = await twins.apps.drive.createFolder(binder.folders['3']!, exhibitId);
  const sourcesFolder = await twins.apps.drive.createFolder(exFolder.id, 'sources');
  const entry = { folder: exFolder.id, sources: sourcesFolder.id };
  ledger.set(`exfolder:${exhibitId}`, JSON.stringify(entry));
  return entry;
}

async function stageSnapshot(twins: MemoryTwins, binder: BinderIds, name: string, body: string): Promise<{ id: string; sha256: string }> {
  const file = await twins.apps.drive.createFile({ parentId: binder.staging, name, mimeType: 'text/html', content: body });
  return { id: file.id, sha256: file.sha256! };
}

function figureRow(p: { fig_id: string; exhibit_id: string; sources: FigureSource[] }): FigureRow {
  return {
    fig_id: p.fig_id,
    exhibit_id: p.exhibit_id,
    criterion: 3,
    measure: 'monthly readers',
    value: 1_200_000,
    unit: 'monthly readers',
    as_of: '2026-08-01',
    sources: p.sources,
    label: 'independently_confirmed',
    note: 'Devtools Weekly reaches about 1,200,000 monthly readers, per its media kit and AMR, as of August 2026.',
    status: 'pending',
    fingerprint: `fp-${p.fig_id}`,
    detail: null,
    queued_at: NOW.toISOString(),
    decided_at: null,
    decision_reason: null,
    run_id: 'r1',
    trace_id: null,
  };
}

describe('review queue: approving writes context-notes.md and moves snapshots into sources/', () => {
  it('an approved row is written to context-notes.md and its snapshot leaves staging', async () => {
    const { twins, ledger, binder, reviewDeps } = await setup();
    const exId = 'EX-3-001';
    const folders = await makeExhibitFolder(twins, ledger, binder, exId);
    const snap = await stageSnapshot(twins, binder, 'snap1.html', '<html>Devtools Weekly reaches 1,200,000 monthly readers.</html>');
    const row = figureRow({ fig_id: 'FIG-001', exhibit_id: exId, sources: [{ kind: 'primary', url: 'https://devtoolsweekly.example/media-kit', publisher: 'Devtools Weekly', sentence: 'reaches 1,200,000', snapshot_html_id: snap.id, snapshot_pdf_id: null, snapshot_sha256: snap.sha256, as_of: '2026-08-01' }] });
    ledger.insertFigure(row);
    await queueFigures([row], reviewDeps);
    const sheetId = ledger.get('review_sheet')!;
    twins.adminSetSheetCell(sheetId, { column: 'ID', equals: 'FIG-001' }, 'Decision', 'Approve');

    const summary = await applyDecisions(reviewDeps);
    expect(summary.approved).toEqual(['FIG-001']);
    expect(ledger.figure('FIG-001')!.status).toBe('approved');

    const notesFile = await twins.apps.drive.findChild(folders.folder, 'context-notes.md');
    expect(notesFile).not.toBeNull();
    const notesText = Buffer.from(await twins.apps.drive.readFile(notesFile!.id)).toString('utf8');
    expect(notesText).toContain('FIG-001');
    expect(notesText).toContain('independently confirmed');

    // The snapshot moved out of staging into the exhibit's sources/ folder.
    const stillInStaging = await twins.apps.drive.listChildren(binder.staging);
    expect(stillInStaging.some((f) => f.id === snap.id)).toBe(false);
    const nowInSources = await twins.apps.drive.listChildren(folders.sources);
    expect(nowInSources.some((f) => f.id === snap.id)).toBe(true);
    ledger.close();
  });
});

describe('review queue: denying moves the item into denied/ and records its fingerprint', () => {
  it('a deny with a reason updates status, moves snapshots to denied/, and marks the fingerprint denied', async () => {
    const { twins, ledger, binder, reviewDeps } = await setup();
    const exId = 'EX-3-002';
    await makeExhibitFolder(twins, ledger, binder, exId);
    const snap = await stageSnapshot(twins, binder, 'snap2.html', '<html>Some figure page.</html>');
    const row = figureRow({ fig_id: 'FIG-002', exhibit_id: exId, sources: [{ kind: 'primary', url: 'https://x.example/page', publisher: 'X', sentence: 'a sentence', snapshot_html_id: snap.id, snapshot_pdf_id: null, snapshot_sha256: snap.sha256, as_of: '2026-08-01' }] });
    ledger.insertFigure(row);
    await queueFigures([row], reviewDeps);
    const sheetId = ledger.get('review_sheet')!;
    twins.adminSetSheetCell(sheetId, { column: 'ID', equals: 'FIG-002' }, 'Decision', 'Deny');
    twins.adminSetSheetCell(sheetId, { column: 'ID', equals: 'FIG-002' }, 'Reason', 'Not a real primary source.');

    const summary = await applyDecisions(reviewDeps);
    expect(summary.denied).toEqual(['FIG-002']);
    expect(ledger.figure('FIG-002')!.status).toBe('denied');
    expect(ledger.isDenied('fp-FIG-002')).toBe(true);

    const deniedChildren = await twins.apps.drive.listChildren(binder.denied);
    expect(deniedChildren.some((f) => f.id === snap.id)).toBe(true);
    ledger.close();
  });
});

describe('review queue: a deny with no reason string stays pending, not silently accepted', () => {
  it('is flagged and left pending when Reason is blank', async () => {
    const { twins, ledger, binder, reviewDeps } = await setup();
    const exId = 'EX-3-003';
    await makeExhibitFolder(twins, ledger, binder, exId);
    const row = figureRow({ fig_id: 'FIG-003', exhibit_id: exId, sources: [] });
    ledger.insertFigure(row);
    await queueFigures([row], reviewDeps);
    const sheetId = ledger.get('review_sheet')!;
    twins.adminSetSheetCell(sheetId, { column: 'ID', equals: 'FIG-003' }, 'Decision', 'Deny');
    // No Reason set.

    const summary = await applyDecisions(reviewDeps);
    expect(summary.pending).toContain('FIG-003');
    expect(summary.denied).not.toContain('FIG-003');
    expect(summary.flagged.some((f) => f.fig_id === 'FIG-003' && /without a reason/.test(f.issue))).toBe(true);
    expect(ledger.figure('FIG-003')!.status).toBe('pending');
    ledger.close();
  });
});

describe('review queue: an item with no decision at all stays pending and writes nothing further (E46)', () => {
  it('the row is neither approved nor denied, and no context notes are written', async () => {
    const { twins, ledger, binder, reviewDeps } = await setup();
    const exId = 'EX-3-004';
    const folders = await makeExhibitFolder(twins, ledger, binder, exId);
    const row = figureRow({ fig_id: 'FIG-004', exhibit_id: exId, sources: [] });
    ledger.insertFigure(row);
    await queueFigures([row], reviewDeps);
    // Decision and Reason left entirely blank.

    const summary = await applyDecisions(reviewDeps);
    expect(summary.pending).toContain('FIG-004');
    expect(summary.approved).not.toContain('FIG-004');
    expect(summary.denied).not.toContain('FIG-004');
    expect(ledger.figure('FIG-004')!.status).toBe('pending');
    const notesFile = await twins.apps.drive.findChild(folders.folder, 'context-notes.md');
    expect(notesFile).toBeNull();
    ledger.close();
  });
});

describe('review queue: an edited value cell is flagged and not auto-accepted (E47)', () => {
  it('flags the row when the Figure and value cell no longer matches the ledger figure', async () => {
    const { twins, ledger, binder, reviewDeps } = await setup();
    const exId = 'EX-3-005';
    await makeExhibitFolder(twins, ledger, binder, exId);
    const row = figureRow({ fig_id: 'FIG-005', exhibit_id: exId, sources: [] });
    ledger.insertFigure(row);
    await queueFigures([row], reviewDeps);
    const sheetId = ledger.get('review_sheet')!;
    // Someone changed the figure text directly in the sheet, and also approved it.
    twins.adminSetSheetCell(sheetId, { column: 'ID', equals: 'FIG-005' }, 'Figure and value', 'monthly readers: 9,999,999 monthly readers');
    twins.adminSetSheetCell(sheetId, { column: 'ID', equals: 'FIG-005' }, 'Decision', 'Approve');

    const summary = await applyDecisions(reviewDeps);
    expect(summary.flagged.some((f) => f.fig_id === 'FIG-005' && /value cell edited/.test(f.issue))).toBe(true);
    // The original (correct) figure value is still what gets written -- the edit is flagged, not trusted.
    expect(figureCell(ledger.figure('FIG-005')!)).not.toBe('monthly readers: 9,999,999 monthly readers');
    ledger.close();
  });
});

describe('review queue: a staged snapshot whose bytes changed after staging is not written/accepted (E48)', () => {
  it('an approve is rejected back to insufficient_sources when the snapshot hash no longer matches', async () => {
    const { twins, ledger, binder, reviewDeps } = await setup();
    const exId = 'EX-3-006';
    const folders = await makeExhibitFolder(twins, ledger, binder, exId);
    const snap = await stageSnapshot(twins, binder, 'snap6.html', '<html>Original snapshot content.</html>');
    const row = figureRow({ fig_id: 'FIG-006', exhibit_id: exId, sources: [{ kind: 'primary', url: 'https://y.example/page', publisher: 'Y', sentence: 'a sentence', snapshot_html_id: snap.id, snapshot_pdf_id: null, snapshot_sha256: snap.sha256, as_of: '2026-08-01' }] });
    ledger.insertFigure(row);
    await queueFigures([row], reviewDeps);

    // Tamper with the staged file after it was queued.
    await twins.apps.drive.updateFileContent(snap.id, '<html>TAMPERED content, different from the queued snapshot.</html>');

    const sheetId = ledger.get('review_sheet')!;
    twins.adminSetSheetCell(sheetId, { column: 'ID', equals: 'FIG-006' }, 'Decision', 'Approve');
    const summary = await applyDecisions(reviewDeps);

    expect(summary.approved).not.toContain('FIG-006');
    expect(summary.flagged.some((f) => f.fig_id === 'FIG-006' && /snapshot hash changed/.test(f.issue))).toBe(true);
    expect(ledger.figure('FIG-006')!.status).toBe('insufficient_sources');
    const notesFile = await twins.apps.drive.findChild(folders.folder, 'context-notes.md');
    expect(notesFile).toBeNull();
    ledger.close();
  });
});

describe('review queue: exactly one digest email is sent per processing run with new rows, addressed to the founder only', () => {
  it('queueFigures sends exactly one gmail.send to the founder\'s own address', async () => {
    const { twins, ledger, reviewDeps } = await setup();
    const exId = 'EX-3-007';
    await ledger.set(`exfolder:${exId}`, JSON.stringify({ folder: 'x', sources: 'y' }));
    const rows = [
      figureRow({ fig_id: 'FIG-007', exhibit_id: exId, sources: [] }),
      figureRow({ fig_id: 'FIG-008', exhibit_id: exId, sources: [] }),
    ];
    for (const r of rows) ledger.insertFigure(r);
    const before = (await twins.apps.gmail.listMessages()).length;
    const { digestSent } = await queueFigures(rows, reviewDeps);
    expect(digestSent).toBe(true);
    const after = await twins.apps.gmail.listMessages();
    const sentDigests = after.filter((m) => m.labels.includes('SENT') && m.subject.includes('figures waiting for review'));
    expect(sentDigests).toHaveLength(1);
    expect(sentDigests[0]!.to).toEqual([PROFILE.emails[0]]);
    expect(after.length - before).toBe(1);
    ledger.close();
  });

  it('queueFigures with no new rows sends no digest at all', async () => {
    const { reviewDeps } = await setup();
    const { digestSent } = await queueFigures([], reviewDeps);
    expect(digestSent).toBe(false);
  });
});

describe('review queue: a whitespace/case-mangled ID cell still applies the founder\'s decision (R5)', () => {
  it('"FIG-001 ( v2 ) " with a trailing space and mixed case still resolves to Approve', async () => {
    const { twins, ledger, binder, reviewDeps } = await setup();
    const exId = 'EX-3-500';
    const folders = await makeExhibitFolder(twins, ledger, binder, exId);
    const snap = await stageSnapshot(twins, binder, 'snap.html', '<html>Devtools Weekly reaches 1,200,000 monthly readers.</html>');
    const row = figureRow({ fig_id: 'FIG-001', exhibit_id: exId, sources: [{ kind: 'primary', url: 'https://devtoolsweekly.example/media-kit', publisher: 'Devtools Weekly', sentence: 'reaches 1,200,000', snapshot_html_id: snap.id, snapshot_pdf_id: null, snapshot_sha256: snap.sha256, as_of: '2026-08-01' }] });
    ledger.insertFigure(row);
    ledger.set('fig_version:FIG-001', '2'); // pretend this figure was re-queued once, so it's now at v2
    await queueFigures([row], reviewDeps);
    const sheetId = ledger.get('review_sheet')!;
    // The row was appended with the bare "FIG-001" id (rowFor only adds the "(vN)" suffix when it
    // knows the version at append time); simulate the founder's own row instead carrying the mangled
    // cell "FIG-001 (v2) " with a stray trailing space and lower-cased "v2".
    twins.adminSetSheetCell(sheetId, { column: 'ID', equals: 'FIG-001 (v2)' }, 'ID', 'FIG-001 ( v2 ) ');
    twins.adminSetSheetCell(sheetId, { column: 'ID', equals: 'FIG-001 ( v2 ) ' }, 'Decision', 'Approve');

    const summary = await applyDecisions(reviewDeps);
    expect(summary.approved).toEqual(['FIG-001']);
    expect(ledger.figure('FIG-001')!.status).toBe('approved');
    void folders;
    ledger.close();
  });
});

describe('review queue: an ID cell that never resolves to a known figure, but carries a decision, is flagged (R5)', () => {
  it('flags the row instead of silently dropping the founder\'s decision', async () => {
    const { twins, ledger, reviewDeps } = await setup();
    // Seed a sheet with a garbage ID cell (e.g. from a copy/paste mistake) that carries a Decision.
    const { sheetId } = await ensureSheetForTest(twins, ledger);
    await twins.apps.sheets.appendRows(sheetId, [['not-a-fig-id', 'EX-3-999', '#3', 'Monthly readers: 1', '2026-08-01', '', '', '', '', 'Approve', 'looks fine']]);

    const summary = await applyDecisions(reviewDeps);
    expect(summary.approved).toEqual([]);
    expect(summary.flagged.some((f) => f.fig_id === 'NOT-A-FIG-ID' && f.issue.includes('did not match a known figure'))).toBe(true);
    ledger.close();
  });
});

describe('review queue: approved figures follow a versioned exhibit (F3 regression)', () => {
  it('an approved figure on a .v2 exhibit appears in that exhibit\'s context-notes.md, and stays after a second run', async () => {
    const { twins, ledger, binder, reviewDeps } = await setup();
    const baseId = 'EX-3-010';
    const versionedId = `${baseId}.v2`;
    // The Drive folder is keyed by the base id (filer.ts's re-file writes into the same exhibit
    // folder across versions), but the figure was corroborated against the exhibit's current
    // (versioned) id, matching how corroborator.ts stamps exhibit_id.
    const folders = await makeExhibitFolder(twins, ledger, binder, baseId);
    const snap = await stageSnapshot(twins, binder, 'snap10.html', '<html>Devtools Weekly reaches 1,200,000 monthly readers.</html>');
    const row = figureRow({ fig_id: 'FIG-010', exhibit_id: versionedId, sources: [{ kind: 'primary', url: 'https://devtoolsweekly.example/media-kit', publisher: 'Devtools Weekly', sentence: 'reaches 1,200,000', snapshot_html_id: snap.id, snapshot_pdf_id: null, snapshot_sha256: snap.sha256, as_of: '2026-08-01' }] });
    ledger.insertFigure(row);
    await queueFigures([row], reviewDeps);
    const sheetId = ledger.get('review_sheet')!;
    twins.adminSetSheetCell(sheetId, { column: 'ID', equals: 'FIG-010' }, 'Decision', 'Approve');

    const summary = await applyDecisions(reviewDeps);
    expect(summary.approved).toEqual(['FIG-010']);

    const notesFile = await twins.apps.drive.findChild(folders.folder, 'context-notes.md');
    expect(notesFile).not.toBeNull();
    const notesText = Buffer.from(await twins.apps.drive.readFile(notesFile!.id)).toString('utf8');
    expect(notesText).toContain('FIG-010');

    // A second run (e.g. a later invocation with nothing new to decide) must not drop the line.
    const summary2 = await applyDecisions(reviewDeps);
    expect(summary2.approved).toEqual([]);
    const notesText2 = Buffer.from(await twins.apps.drive.readFile(notesFile!.id)).toString('utf8');
    expect(notesText2).toContain('FIG-010');
    ledger.close();
  });
});

describe('review queue: notes survive a re-file from v1 to v2', () => {
  it('after a re-file from v1 to v2, notes still show approved figures exactly once', async () => {
    const { twins, ledger, binder, reviewDeps } = await setup();
    const baseId = 'EX-3-011';
    const folders = await makeExhibitFolder(twins, ledger, binder, baseId);
    const snap = await stageSnapshot(twins, binder, 'snap11.html', '<html>Devtools Weekly reaches 1,200,000 monthly readers.</html>');
    // Figure created and approved while the exhibit was still at v1 (bare id, no suffix).
    const row = figureRow({ fig_id: 'FIG-011', exhibit_id: baseId, sources: [{ kind: 'primary', url: 'https://devtoolsweekly.example/media-kit', publisher: 'Devtools Weekly', sentence: 'reaches 1,200,000', snapshot_html_id: snap.id, snapshot_pdf_id: null, snapshot_sha256: snap.sha256, as_of: '2026-08-01' }] });
    ledger.insertFigure(row);
    await queueFigures([row], reviewDeps);
    const sheetId = ledger.get('review_sheet')!;
    twins.adminSetSheetCell(sheetId, { column: 'ID', equals: 'FIG-011' }, 'Decision', 'Approve');
    await applyDecisions(reviewDeps);

    const notesFile = await twins.apps.drive.findChild(folders.folder, 'context-notes.md');
    const before = Buffer.from(await twins.apps.drive.readFile(notesFile!.id)).toString('utf8');
    expect(before.match(/FIG-011/g)?.length).toBe(1);

    // Re-file bumps the exhibit to v2; the figure's stamped exhibit_id is untouched (it points at v1).
    const newRow = figureRow({ fig_id: 'FIG-012', exhibit_id: `${baseId}.v2`, sources: [] });
    ledger.insertFigure({ ...newRow, status: 'pending' });

    // Re-running applyDecisions (nothing new decided) must still render exactly one FIG-011 line.
    await applyDecisions(reviewDeps);
    const after = Buffer.from(await twins.apps.drive.readFile(notesFile!.id)).toString('utf8');
    expect(after.match(/FIG-011/g)?.length).toBe(1);
    ledger.close();
  });
});

/** ensureSheet is not exported; create the review sheet the same way queueFigures would (via a
 * no-op queueFigures call with an empty batch, which still creates the sheet on first use). */
async function ensureSheetForTest(twins: MemoryTwins, ledger: Ledger): Promise<{ sheetId: string }> {
  const { spreadsheetId } = await twins.apps.sheets.create('Exhibit review', REVIEW_HEADERS);
  ledger.set('review_sheet', spreadsheetId);
  return { sheetId: spreadsheetId };
}
