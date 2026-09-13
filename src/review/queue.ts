import type { Apps } from '../apps/types.js';
import { TwinExpiredError, TwinStubError } from '../apps/types.js';
import type { BinderIds } from '../binder/filer.js';
import { upsertText } from '../binder/filer.js';
import type { FigureRow, Ledger } from '../ledger.js';
import type { TraceContext } from '../observability/tracer.js';
import type { FounderProfile } from '../types.js';
import { sha256 } from '../util.js';

// Review queue (PRD 6.12). The founder approves every figure in a private Sheet. The agent appends
// rows, reads only Decision and Reason, and writes nothing to the binder without an Approve.

export const REVIEW_SHEET_TITLE = 'Exhibit review';
export const REVIEW_HEADERS = ['ID', 'Exhibit', 'Criterion', 'Figure and value', 'As of', 'Source 1', 'Source 2', 'Label', 'Note', 'Decision', 'Reason'];

export interface ReviewDeps {
  apps: Apps;
  ledger: Ledger;
  trace: TraceContext;
  profile: FounderProfile;
  binder: BinderIds;
  runId: string;
  now: Date;
}

export interface ReviewSummary {
  approved: string[];
  denied: string[];
  pending: string[];
  flagged: { fig_id: string; issue: string }[];
  digestSent: boolean;
  /** Apps that failed genuinely (not a twin stub/expiry) while applying decisions or queueing (PRD 10). */
  degraded: string[];
}

async function ensureSheet(deps: ReviewDeps): Promise<string> {
  const existing = deps.ledger.get('review_sheet');
  if (existing) return existing;
  const { spreadsheetId } = await deps.apps.sheets.create(REVIEW_SHEET_TITLE, REVIEW_HEADERS);
  deps.ledger.set('review_sheet', spreadsheetId);
  deps.trace.tool('sheets.create', { title: REVIEW_SHEET_TITLE }, { spreadsheetId });
  return spreadsheetId;
}

export function figureCell(f: FigureRow): string {
  return `${f.measure}: ${f.value.toLocaleString('en-US')} ${f.unit}`;
}

function sourceCell(f: FigureRow, i: number): string {
  const s = f.sources[i];
  if (!s) return '';
  return `${s.publisher} | ${s.kind} | ${s.url} | "${s.sentence}" | snapshot drive:${s.snapshot_pdf_id}`;
}

/** Current ledger version of a figure's row identity (constraint 13). Unversioned figures default to 1. */
export function figVersion(ledger: Ledger, figId: string): number {
  const raw = ledger.get(`fig_version:${figId}`);
  const n = raw ? Number(raw) : 1;
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/**
 * Parses the ID cell of a Sheet row back into a fig_id and the version it was queued at. Rows
 * written before versioning existed (or at v1) carry the bare fig_id and parse as version 1, so
 * old Sheets keep working without a migration.
 */
export function parseIdCell(idCell: string): { figId: string; version: number } {
  const trimmed = idCell.trim();
  const m = /^(.*?)\s*\(\s*v(\d+)\s*\)$/i.exec(trimmed);
  const figId = (m ? m[1]! : trimmed).trim().toUpperCase();
  return { figId, version: m ? Number(m[2]) : 1 };
}

export function rowFor(f: FigureRow, version = 1): string[] {
  return [
    version > 1 ? `${f.fig_id} (v${version})` : f.fig_id,
    f.exhibit_id,
    `#${f.criterion}`,
    figureCell(f),
    f.as_of,
    sourceCell(f, 0),
    sourceCell(f, 1),
    f.label === 'independently_confirmed' ? 'Independently confirmed' : 'Issuer-confirmed',
    f.note,
    '',
    '',
  ];
}

/**
 * Append every pending figure not yet on the Sheet -- not only the ones queued this exact run, so
 * figures queued during an earlier degraded run reach the Sheet once it recovers (PRD 10) -- and
 * send one digest to the founder's own address. `queued` names the figures new this run only for
 * the digest wording; which rows actually get appended is read back from the ledger.
 */
export async function queueFigures(queued: FigureRow[], deps: ReviewDeps): Promise<{ sheetId: string; digestSent: boolean; degraded: string[] }> {
  const degraded: string[] = [];
  let sheetId: string;
  try {
    sheetId = await ensureSheet(deps);
  } catch (err) {
    if (err instanceof TwinStubError || err instanceof TwinExpiredError) throw err;
    deps.trace.tool('sheets.create', { title: REVIEW_SHEET_TITLE }, undefined, String(err));
    return { sheetId: '', digestSent: false, degraded: ['sheets'] };
  }
  const toAppend = deps.ledger.figures({ status: 'pending' }).filter((f) => !deps.ledger.get(`on_sheet:${f.fig_id}`));
  if (toAppend.length === 0) return { sheetId, digestSent: false, degraded };
  try {
    await deps.apps.sheets.appendRows(sheetId, toAppend.map((f) => rowFor(f, figVersion(deps.ledger, f.fig_id))));
  } catch (err) {
    if (err instanceof TwinStubError || err instanceof TwinExpiredError) throw err;
    deps.trace.tool('sheets.values.append', { spreadsheetId: sheetId, rows: toAppend.map((q) => q.fig_id) }, undefined, String(err));
    return { sheetId, digestSent: false, degraded: ['sheets'] };
  }
  deps.trace.tool('sheets.values.append', { spreadsheetId: sheetId, rows: toAppend.map((q) => q.fig_id) }, { appended: toAppend.length });
  for (const f of toAppend) deps.ledger.set(`on_sheet:${f.fig_id}`, '1');
  const to = deps.profile.emails[0]!;
  const subject = `[Exhibit] ${toAppend.length} figure${toAppend.length === 1 ? '' : 's'} waiting for review`;
  const body = [
    `${toAppend.length} context figure${toAppend.length === 1 ? '' : 's'} passed the source checks and need your decision.`,
    '',
    `Open the review sheet: https://docs.google.com/spreadsheets/d/${sheetId}`,
    '',
    'Each row shows the figure, both sources with links, the exact sentences and the snapshots. Choose Approve or Deny (Deny needs a reason). Nothing enters the binder without your Approve.',
    '',
    ...toAppend.map((q) => `- ${q.fig_id} (${q.exhibit_id}): ${figureCell(q)}`),
  ].join('\n');
  try {
    const sent = await deps.apps.gmail.send({ to: [to], subject, body });
    deps.trace.tool('gmail.send', { to: [to], subject, kind: 'digest_to_self' }, { id: sent.id });
    deps.ledger.event({ run_id: deps.runId, trace_id: deps.trace.traceId, kind: 'digest_sent', detail: { message_id: sent.id, figures: toAppend.map((q) => q.fig_id) }, at: deps.now.toISOString() });
    return { sheetId, digestSent: true, degraded };
  } catch (err) {
    if (err instanceof TwinStubError || err instanceof TwinExpiredError) throw err;
    deps.trace.tool('gmail.send', { to: [to], subject, kind: 'digest_to_self' }, undefined, String(err));
    return { sheetId, digestSent: false, degraded: ['gmail'] };
  }
}

async function contextNotesFile(deps: ReviewDeps, exhibitId: string): Promise<{ folder: string; sources: string } | null> {
  const raw = deps.ledger.get(`exfolder:${exhibitId.split('.v')[0]}`);
  return raw ? (JSON.parse(raw) as { folder: string; sources: string }) : null;
}

/**
 * `context-notes.md` is a derived, regenerable view (not a filed artifact under hard constraint 5):
 * it is rendered fresh from the ledger's currently-approved figures for the exhibit every time this
 * is called, never accreted line-by-line. That makes "current" mean exactly "approved right now" --
 * a figure that was approved and later denied, or reset to `pending` by a freshness re-queue
 * (src/research/freshness.ts), drops out the next time this renders, and a re-approved figure is
 * written exactly once because the ledger holds one row per fig_id (constraint 13's version bump
 * only changes which Sheet row can supply a decision, not the figure's identity).
 */
export async function renderContextNotes(deps: ReviewDeps, exhibitId: string): Promise<void> {
  const target = await contextNotesFile(deps, exhibitId);
  if (!target) return;
  const baseId = exhibitId.split('.v')[0]!;
  // Ledger.figures({ exhibitId }) matches exhibit_id exactly, but a figure's exhibit_id was stamped
  // at creation time and may carry an older or newer `.vN` suffix than the exhibit's current version
  // (filer.ts bumps the exhibit's version independently of when figures were corroborated). Filter by
  // the stripped base id here so approved figures follow their exhibit across re-files.
  const approved = deps.ledger.figures({ status: 'approved' }).filter((f) => f.exhibit_id.split('.v')[0] === baseId);
  if (approved.length === 0) {
    // Never create the file just to hold the "approved figures only" header -- E46/E48 expect no
    // context-notes.md while nothing has ever been approved. If a note already exists (a figure was
    // approved before and has since gone stale/denied), it must still be resynced down to the header
    // so it stops showing that figure as current.
    const existing = await deps.apps.drive.findChild(target.folder, 'context-notes.md');
    if (!existing) return;
  }
  const header = `# Context notes for ${baseId}\n\nApproved figures only. Each line: value, as-of date, both sources with kind, snapshots, label, approval date.\n`;
  const blocks = approved.map((fig) =>
    [
      `- ${fig.fig_id}: ${figureCell(fig)} (as of ${fig.as_of}).`,
      ...fig.sources.map((s, i) => `  Source ${i + 1} (${s.kind}): ${s.publisher}, ${s.url}; snapshots drive:${s.snapshot_html_id}, drive:${s.snapshot_pdf_id}.`),
      `  Label: ${fig.label === 'independently_confirmed' ? 'independently confirmed' : 'issuer-confirmed'}. Approved ${(fig.decided_at ?? deps.now.toISOString()).slice(0, 10)}.`,
      `  ${fig.note}`,
    ].join('\n'),
  );
  const content = blocks.length ? `${header}\n${blocks.join('\n\n')}\n` : header;
  await upsertText(deps.apps.drive, target.folder, 'context-notes.md', content);
}

/**
 * Row identity is the figure's ledger version (constraint 13), not row order. Each fig_id's rows
 * are grouped and filtered down to only those whose ID cell encodes the figure's CURRENT version
 * (`figVersion`); a row from an older version is ignored no matter where it sits in the sheet --
 * an append failure, a crash before the fresh row lands, or the founder reordering/sorting the
 * sheet all leave old-version rows inert. If no row carries the current version yet, the figure
 * stays pending. requeueStaleFigures bumps the version when it re-queues a stale figure, so the
 * old Approve can never be re-read as a decision on the new version.
 */
export async function applyDecisions(deps: ReviewDeps): Promise<ReviewSummary> {
  const { apps, ledger, trace, now } = deps;
  const summary: ReviewSummary = { approved: [], denied: [], pending: [], flagged: [], digestSent: false, degraded: [] };
  // Resync context notes for every exhibit with at least one figure before reading any Sheet
  // decisions this run. This is what makes freshness.ts's re-queue of a stale approved figure (which
  // flips it from `approved` back to `pending` with no Drive write of its own) show up promptly:
  // context-notes.md is a pure render of "approved right now", so the stale figure's line disappears
  // here even though no Approve/Deny happened this run (a no-op for exhibits with no notes file yet).
  const exhibitIds = new Set(ledger.figures().map((f) => f.exhibit_id.split('.v')[0]!));
  for (const exhibitId of exhibitIds) await renderContextNotes(deps, exhibitId);
  const sheetId = ledger.get('review_sheet');
  if (!sheetId) return summary;
  let rows: string[][];
  try {
    rows = await apps.sheets.readRows(sheetId);
  } catch (err) {
    if (err instanceof TwinStubError || err instanceof TwinExpiredError) throw err;
    trace.tool('sheets.values.get', { spreadsheetId: sheetId }, undefined, String(err));
    summary.degraded.push('sheets');
    return summary;
  }
  trace.tool('sheets.values.get', { spreadsheetId: sheetId }, { rows: rows.length - 1 });
  const header = rows[0] ?? REVIEW_HEADERS;
  const col = (name: string) => header.indexOf(name);

  // Group every row by fig_id, independent of order (a sort/reorder or a mid-run crash must not
  // change which row counts).
  const rowsByFigId = new Map<string, string[][]>();
  for (const row of rows.slice(1)) {
    const idCell = row[col('ID')] ?? '';
    if (!idCell) continue;
    const { figId } = parseIdCell(idCell);
    if (!figId) continue;
    const arr = rowsByFigId.get(figId);
    if (arr) arr.push(row);
    else rowsByFigId.set(figId, [row]);
  }

  for (const [figId, allRows] of rowsByFigId) {
    const fig = ledger.figure(figId);
    if (!fig) {
      // The ID cell didn't resolve to any figure the agent knows about (garbled beyond whitespace
      // and case tolerance, or a stray value entirely). If the founder nonetheless recorded a
      // decision on the row, don't let it vanish silently (R5) -- flag it the way a value-cell edit
      // is flagged, so it surfaces to her instead of being read as "no decision".
      const hasDecision = allRows.some((r) => (r[col('Decision')] ?? '').trim() !== '');
      if (hasDecision) summary.flagged.push({ fig_id: figId, issue: 'ID cell did not match a known figure; decision could not be applied' });
      continue;
    }
    if (fig.status !== 'pending') continue;
    const currentVersion = figVersion(ledger, figId);
    const matching = allRows.filter((r) => parseIdCell(r[col('ID')] ?? '').version === currentVersion);
    if (matching.length === 0) {
      // No row carries the figure's current version yet (append failed, run crashed before
      // queueFigures ran, or only stale-version rows exist). Stay pending; never fall back to an
      // older-version row.
      summary.pending.push(figId);
      continue;
    }
    const row = matching[matching.length - 1]!;
    if ((row[col('Figure and value')] ?? '') !== figureCell(fig)) {
      summary.flagged.push({ fig_id: figId, issue: 'value cell edited in the Sheet; ignored (the agent reads only Decision and Reason)' });
    }
    const decision = (row[col('Decision')] ?? '').trim().toLowerCase();
    const reason = (row[col('Reason')] ?? '').trim();

    if (decision === 'approve' || decision === 'deny') await decideFigure(fig, decision, reason, deps, summary);
    else summary.pending.push(figId);
  }
  for (const f of summary.flagged) ledger.event({ run_id: deps.runId, trace_id: trace.traceId, kind: 'review_flag', detail: f, at: now.toISOString() });
  return summary;
}

/** One founder decision, applied exactly as the Sheet would (6.12); the text channel (6.13) calls this too. */
export async function decideFigure(fig: FigureRow, decision: 'approve' | 'deny', reason: string, deps: ReviewDeps, summary: ReviewSummary): Promise<void> {
  const { apps, ledger, trace, now } = deps;
  const figId = fig.fig_id;
  if (fig.status !== 'pending') {
    summary.flagged.push({ fig_id: figId, issue: `already ${fig.status}; decision ignored` });
    return;
  }
  {
    if (decision === 'approve') {
      // Re-check that the snapshots are unchanged since the row was queued (E48).
      let intact = true;
      for (const s of fig.sources) {
        if (!s.snapshot_html_id) continue;
        const bytes = await apps.drive.readFile(s.snapshot_html_id);
        if (sha256(bytes) !== s.snapshot_sha256) intact = false;
      }
      if (!intact) {
        ledger.updateFigure(figId, { status: 'insufficient_sources', detail: 'snapshot changed between queueing and approval; re-queued for fresh research' });
        ledger.set(`corroborated:${fig.exhibit_id.split('.v')[0]}`, '');
        summary.flagged.push({ fig_id: figId, issue: 'snapshot hash changed; not written' });
        return;
      }
      const target = await contextNotesFile(deps, fig.exhibit_id);
      if (!target) {
        summary.flagged.push({ fig_id: figId, issue: 'exhibit folder not found; not written' });
        return;
      }
      for (const s of fig.sources) {
        for (const id of [s.snapshot_html_id, s.snapshot_pdf_id]) if (id) await apps.drive.moveFile(id, deps.binder.staging, target.sources);
      }
      ledger.updateFigure(figId, { status: 'approved', decided_at: now.toISOString(), decision_reason: reason || null });
      await renderContextNotes(deps, fig.exhibit_id);
      trace.tool('drive.context_notes.write', { exhibit_id: fig.exhibit_id, fig_id: figId }, { approved: true });
      summary.approved.push(figId);
    } else {
      if (!reason) {
        summary.flagged.push({ fig_id: figId, issue: 'Deny without a reason; left pending' });
        summary.pending.push(figId);
        return;
      }
      for (const s of fig.sources) {
        for (const id of [s.snapshot_html_id, s.snapshot_pdf_id]) if (id) await apps.drive.moveFile(id, deps.binder.staging, deps.binder.denied);
      }
      ledger.updateFigure(figId, { status: 'denied', decided_at: now.toISOString(), decision_reason: reason });
      ledger.deny(fig.fingerprint, figId, reason, now.toISOString());
      await renderContextNotes(deps, fig.exhibit_id);
      trace.tool('review.deny', { fig_id: figId }, { reason });
      summary.denied.push(figId);
    }
  }
}
