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

export function rowFor(f: FigureRow): string[] {
  return [
    f.fig_id,
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
    await deps.apps.sheets.appendRows(sheetId, toAppend.map(rowFor));
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
 * `justStale` names figures that requeueStaleFigures just reset to `pending` this same run
 * (PRD 6.11). Their Sheet row still carries the founder's Approve from before staleness -- that
 * decision was made on a number that is now considered too old, so it must not count (constraint
 * 13). Those figures are held pending here regardless of what the (stale) row says; once
 * queueFigures appends a fresh row for them, a later run sees both rows and, because rows are
 * append-only, uses only the LAST row per fig_id -- so the old Approve is superseded rather than
 * re-read.
 */
export async function applyDecisions(deps: ReviewDeps, justStale: Set<string> = new Set()): Promise<ReviewSummary> {
  const { apps, ledger, trace, now } = deps;
  const summary: ReviewSummary = { approved: [], denied: [], pending: [], flagged: [], digestSent: false, degraded: [] };
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

  // Keep only the newest row per fig_id (rows are append-only, so a later row in the sheet
  // supersedes an earlier one for the same figure -- this is what lets a fresh re-queue row
  // override a stale Approve left on an older row).
  const lastRowByFigId = new Map<string, string[]>();
  for (const row of rows.slice(1)) {
    const figId = row[col('ID')] ?? '';
    if (!figId) continue;
    lastRowByFigId.set(figId, row);
  }

  for (const [figId, row] of lastRowByFigId) {
    const fig = ledger.figure(figId);
    if (!fig || fig.status !== 'pending') continue;
    if (justStale.has(figId)) {
      // Went stale this run: no row can carry a valid decision yet (the fresh row is appended
      // later this same run, by queueFigures). Leave pending; do not read the old row at all.
      summary.pending.push(figId);
      continue;
    }
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
      const existing = await apps.drive.findChild(target.folder, 'context-notes.md');
      const prior = existing ? Buffer.from(await apps.drive.readFile(existing.id)).toString('utf8') : `# Context notes for ${fig.exhibit_id.split('.v')[0]}\n\nApproved figures only. Each line: value, as-of date, both sources with kind, snapshots, label, approval date.\n`;
      const line = [
        `- ${fig.fig_id}: ${figureCell(fig)} (as of ${fig.as_of}).`,
        ...fig.sources.map((s, i) => `  Source ${i + 1} (${s.kind}): ${s.publisher}, ${s.url}; snapshots drive:${s.snapshot_html_id}, drive:${s.snapshot_pdf_id}.`),
        `  Label: ${fig.label === 'independently_confirmed' ? 'independently confirmed' : 'issuer-confirmed'}. Approved ${now.toISOString().slice(0, 10)}.`,
        `  ${fig.note}`,
      ].join('\n');
      if (!prior.includes(`- ${fig.fig_id}:`)) await upsertText(apps.drive, target.folder, 'context-notes.md', `${prior.trimEnd()}\n${line}\n`);
      ledger.updateFigure(figId, { status: 'approved', decided_at: now.toISOString(), decision_reason: reason || null });
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
      trace.tool('review.deny', { fig_id: figId }, { reason });
      summary.denied.push(figId);
    }
  }
}
