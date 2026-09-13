import type { DriveApi, DriveFile } from '../apps/types.js';
import type { Ledger } from '../ledger.js';
import type { TraceContext } from '../observability/tracer.js';
import type { ExhibitRecord, FounderProfile, SourceItem, VerifiedItem } from '../types.js';
import { isoDay, sha256, stableJson } from '../util.js';
import { renderPdf } from './pdf.js';

// Filer and binder (PRD 6.6). Filing is append-only: an original is written once and never edited;
// a correction writes a new metadata version and marks the old record superseded.

export const CRITERION_FOLDERS: Record<string, string> = {
  '1': '01-awards',
  '2': '02-membership',
  '3': '03-published-material',
  '4': '04-judging',
  '5': '05-original-contributions',
  '6': '06-scholarly-articles',
  '7': '07-critical-role',
  '8': '08-remuneration',
};

export const BINDER_ROOT = 'Exhibit binder';
export const REVIEW_ROOT = 'Exhibit review';

export interface BinderIds {
  root: string;
  folders: Record<string, string>;
  needsAttorney: string;
  eb1aOnly: string;
  context: string;
  reviewRoot: string;
  staging: string;
  denied: string;
}

export interface FilerDeps {
  drive: DriveApi;
  ledger: Ledger;
  trace: TraceContext;
  profile: FounderProfile;
  runId: string;
  now: Date;
}

async function ensureFolder(drive: DriveApi, parentId: string | null, name: string): Promise<string> {
  const existing = await drive.findChild(parentId, name);
  return existing ? existing.id : (await drive.createFolder(parentId, name)).id;
}

export async function ensureBinder(deps: FilerDeps): Promise<BinderIds> {
  const cached = deps.ledger.get('binder');
  if (cached) return JSON.parse(cached) as BinderIds;
  const { drive } = deps;
  const root = await ensureFolder(drive, null, BINDER_ROOT);
  const folders: Record<string, string> = {};
  for (const [c, name] of Object.entries(CRITERION_FOLDERS)) folders[c] = await ensureFolder(drive, root, name);
  const ids: BinderIds = {
    root,
    folders,
    needsAttorney: await ensureFolder(drive, root, 'needs-attorney'),
    eb1aOnly: await ensureFolder(drive, root, 'eb1a-only'),
    context: await ensureFolder(drive, root, 'context'),
    reviewRoot: await ensureFolder(drive, null, REVIEW_ROOT),
    staging: '',
    denied: '',
  };
  ids.staging = await ensureFolder(drive, ids.reviewRoot, 'staging');
  ids.denied = await ensureFolder(drive, ids.reviewRoot, 'denied');
  await upsertText(drive, ids.context, 'nstc-critical-and-emerging-technologies.md', nstcNote(deps.profile));
  deps.ledger.set('binder', JSON.stringify(ids));
  deps.trace.tool('drive.binder.ensure', { root: BINDER_ROOT }, { root, folders: Object.keys(folders).length });
  return ids;
}

function nstcNote(profile: FounderProfile): string {
  return [
    '# Context: Critical and Emerging Technologies list',
    '',
    `Founder field: ${profile.field}.`,
    'The NSTC Critical and Emerging Technologies list helps show that a field matters to US interests (EB-1A guide). Attach the current list entry for this field from the official White House / NSTC publication before export.',
    '',
    'Source to fetch: https://www.whitehouse.gov/ostp/ (Critical and Emerging Technologies List Update).',
  ].join('\n');
}

export async function upsertText(drive: DriveApi, parentId: string, name: string, content: string, mimeType = 'text/markdown'): Promise<DriveFile> {
  const existing = await drive.findChild(parentId, name);
  if (!existing) return drive.createFile({ parentId, name, mimeType, content });
  if (existing.sha256 === sha256(Buffer.from(content, 'utf8'))) return existing;
  return drive.updateFileContent(existing.id, content);
}

function fileable(v: VerifiedItem): boolean {
  return v.mapping.status === 'qualifying' || v.mapping.status === 'needs_attorney' || v.mapping.eb1a_status === 'qualifying';
}

function folderFor(v: VerifiedItem, ids: BinderIds): { folderId: string; prefix: string; folderName: string } {
  if (v.mapping.status === 'needs_attorney') return { folderId: ids.needsAttorney, prefix: String(v.mapping.criteria[0] ?? 'NA'), folderName: 'needs-attorney' };
  if (v.mapping.criteria.length === 0 || v.mapping.status !== 'qualifying') {
    return { folderId: ids.eb1aOnly, prefix: v.mapping.eb1a_criteria[0] ?? 'EB', folderName: 'eb1a-only' };
  }
  const c = String(v.mapping.criteria[0]);
  return { folderId: ids.folders[c]!, prefix: c, folderName: CRITERION_FOLDERS[c]! };
}

function originalName(item: SourceItem): string {
  return item.rawType === 'eml' ? 'original.eml' : 'original.json';
}

function renderBody(v: VerifiedItem): string {
  const p = v.primary;
  const header = [
    `Source: ${p.app}${p.meta.forwarded ? ' (forwarded; original headers below)' : ''}`,
    `Issuer: ${v.issuer ?? 'unknown'}`,
    `Original date: ${isoDay(v.event_date) ?? 'none in source'}`,
    v.url ? `URL: ${v.url}` : null,
    `Criteria (O-1A): ${v.mapping.criteria.join(', ') || 'none'} - status ${v.mapping.status}`,
    `Criteria (EB-1A): ${v.mapping.eb1a_criteria.join(', ') || 'none'} - status ${v.mapping.eb1a_status}`,
    `Working rule: ${v.mapping.rule_id}. ${v.mapping.reason}`,
    `Key sentence: "${v.mapping.quote}"`,
    '',
    `Subject / title: ${p.title}`,
    p.author?.email ? `From: ${p.author.name ?? ''} <${p.author.email}>` : null,
    '',
  ].filter((l) => l !== null);
  return `${header.join('\n')}\n${p.text}`;
}

export async function fileVerified(v: VerifiedItem, ids: BinderIds, deps: FilerDeps): Promise<ExhibitRecord | null> {
  if (!fileable(v)) return null;
  const { drive, ledger, trace, runId, now } = deps;
  const prior = ledger.exhibitByKey(v.key);
  const sourceIds = (refs: { app: string; id: string }[]) => refs.map((r) => `${r.app}:${r.id}`).sort().join('|');

  if (prior && prior.status === v.mapping.status && prior.eb1a_status === v.mapping.eb1a_status && sourceIds(prior.sources) === sourceIds(v.sources)) {
    return prior; // idempotent re-run (E18)
  }

  if (prior) {
    // A correction: new metadata version beside the untouched originals.
    const version = prior.version + 1;
    const next: ExhibitRecord = {
      ...prior,
      exhibit_id: `${prior.exhibit_id.split('.v')[0]}.v${version}`,
      criteria: v.mapping.criteria,
      eb1a_criteria: v.mapping.eb1a_criteria,
      status: v.mapping.status,
      eb1a_status: v.mapping.eb1a_status,
      comparable: v.mapping.comparable_for.length > 0,
      comparable_for: v.mapping.comparable_for,
      rule_id: v.mapping.rule_id,
      sources: v.sources,
      metrics: { ...prior.metrics, ...v.metrics },
      reason: v.mapping.reason,
      captured_at: now.toISOString(),
      version,
      supersedes: prior.exhibit_id,
      people: v.people,
    };
    const folder = await drive.findChild(folderFor(v, ids).folderId, prior.exhibit_id.split('.v')[0]!);
    const exFolder = folder?.id ?? (await findExhibitFolder(drive, ids, prior));
    if (exFolder) {
      const srcFolder = await ensureFolderIn(drive, exFolder, 'sources');
      for (const m of v.members) {
        const name = memberName(m);
        if (!(await drive.findChild(srcFolder, name))) await drive.createFile({ parentId: srcFolder, name, mimeType: mimeOf(m), content: m.raw });
      }
      await drive.createFile({ parentId: exFolder, name: `metadata.v${version}.json`, mimeType: 'application/json', content: JSON.stringify(next, null, 2) });
    }
    ledger.insertExhibit(next, runId, trace.traceId);
    ledger.supersede(prior.exhibit_id, next.exhibit_id);
    trace.tool('drive.exhibit.version', { key: v.key }, { exhibit_id: next.exhibit_id, supersedes: prior.exhibit_id });
    return next;
  }

  const { folderId, prefix } = folderFor(v, ids);
  const exhibitId = ledger.nextExhibitId(prefix);
  const exFolder = (await drive.createFolder(folderId, exhibitId)).id;
  const original = Buffer.from(v.primary.raw, 'utf8');
  const originalFile = await drive.createFile({ parentId: exFolder, name: originalName(v.primary), mimeType: mimeOf(v.primary), content: original, appProperties: { exhibit_id: exhibitId, role: 'original' } });
  const pdf = renderPdf({ heading: `${exhibitId}: ${v.title}`, subheading: `Prepared by Exhibit for attorney review. Not legal advice.`, body: renderBody(v), highlights: v.highlights });
  const pdfFile = await drive.createFile({ parentId: exFolder, name: 'render.pdf', mimeType: 'application/pdf', content: pdf, appProperties: { exhibit_id: exhibitId, role: 'render' } });
  const srcFolder = await drive.createFolder(exFolder, 'sources');
  ledger.set(`exfolder:${exhibitId}`, JSON.stringify({ folder: exFolder, sources: srcFolder.id }));
  const memberHashes: Record<string, string> = {};
  for (const m of v.members.filter((x) => x !== v.primary)) {
    const f = await drive.createFile({ parentId: srcFolder.id, name: memberName(m), mimeType: mimeOf(m), content: m.raw, appProperties: { exhibit_id: exhibitId, role: 'member' } });
    memberHashes[f.name] = f.sha256!;
  }

  const record: ExhibitRecord = {
    exhibit_id: exhibitId,
    key: v.key,
    criteria: v.mapping.criteria,
    eb1a_criteria: v.mapping.eb1a_criteria,
    status: v.mapping.status,
    eb1a_status: v.mapping.eb1a_status,
    comparable: v.mapping.comparable_for.length > 0,
    comparable_for: v.mapping.comparable_for,
    rule_id: v.mapping.rule_id,
    metrics: v.metrics,
    title: v.title,
    issuer: v.issuer,
    event_date: isoDay(v.event_date),
    captured_at: now.toISOString(),
    sources: v.sources,
    artifact_path: `${folderFor(v, ids).folderName}/${exhibitId}/`,
    sha256: originalFile.sha256!,
    reason: v.mapping.reason,
    version: 1,
    supersedes: null,
    people: v.people,
  };
  await drive.createFile({
    parentId: exFolder,
    name: 'metadata.json',
    mimeType: 'application/json',
    content: JSON.stringify({ ...record, render_sha256: pdfFile.sha256, member_sha256: memberHashes, checks: v.checks, quote: v.mapping.quote }, null, 2),
    appProperties: { exhibit_id: exhibitId, role: 'metadata' },
  });
  ledger.insertExhibit(record, runId, trace.traceId);
  trace.tool('drive.exhibit.file', { key: v.key, folder: record.artifact_path }, { exhibit_id: exhibitId, sha256: record.sha256, status: record.status, eb1a_status: record.eb1a_status });
  return record;
}

async function ensureFolderIn(drive: DriveApi, parentId: string, name: string): Promise<string> {
  return ensureFolder(drive, parentId, name);
}

async function findExhibitFolder(drive: DriveApi, ids: BinderIds, rec: ExhibitRecord): Promise<string | null> {
  const base = rec.exhibit_id.split('.v')[0]!;
  for (const parent of [...Object.values(ids.folders), ids.needsAttorney, ids.eb1aOnly]) {
    const f = await drive.findChild(parent, base);
    if (f) return f.id;
  }
  return null;
}

function memberName(m: SourceItem): string {
  return `member-${m.app}-${m.id.replace(/[^\w.-]+/g, '_')}.${m.rawType}`;
}

function mimeOf(m: SourceItem): string {
  return m.rawType === 'eml' ? 'message/rfc822' : 'application/json';
}

/** Binder-level derived documents, regenerated from the ledger every run. */
export async function writeBinderIndexes(ids: BinderIds, deps: FilerDeps): Promise<void> {
  const { drive, ledger } = deps;
  const exhibits = ledger.exhibits();
  const lines = ['# Exhibit binder index', '', 'Generated from the ledger. Not legal advice.', ''];
  for (const [c, folder] of Object.entries(CRITERION_FOLDERS)) {
    const under = exhibits.filter((e) => e.criteria.includes(Number(c) as never) && e.status === 'qualifying');
    lines.push(`## ${folder}`, ...(under.length ? under.map((e) => `- ${e.exhibit_id} (${e.event_date ?? 'undated'}) ${e.title} [${e.rule_id}${e.comparable_for.includes(Number(c) as never) ? ', comparable evidence' : ''}]`) : ['- none']), '');
  }
  const na = exhibits.filter((e) => e.status === 'needs_attorney');
  lines.push('## needs-attorney', ...(na.length ? na.map((e) => `- ${e.exhibit_id} ${e.title}: ${e.reason}`) : ['- none']), '');
  const eb = exhibits.filter((e) => e.status !== 'qualifying' && e.status !== 'needs_attorney' && e.eb1a_status === 'qualifying');
  lines.push('## eb1a-only', ...(eb.length ? eb.map((e) => `- ${e.exhibit_id} ${e.title} (EB-1A ${e.eb1a_criteria.join(', ')})`) : ['- none']), '');
  await upsertText(drive, ids.root, 'index.md', lines.join('\n'));

  const rejected = ledger.candidates().filter((c) => c.status === 'rejected' && c.mapping.eb1a_status !== 'qualifying');
  const byRule = new Map<string, typeof rejected>();
  for (const r of rejected) byRule.set(r.mapping.rule_id, [...(byRule.get(r.mapping.rule_id) ?? []), r]);
  const nc = ['# Not counted', '', 'Items considered and not counted, with the reason. An attorney wants to see what was excluded.', ''];
  for (const [rule, rows] of [...byRule].sort()) {
    nc.push(`## ${rule}`, ...rows.map((r) => `- ${isoDay(r.event_date) ?? 'undated'} ${r.title} (${r.issuer ?? 'unknown issuer'}): ${r.mapping.reason}`), '');
  }
  await upsertText(drive, ids.root, 'not-counted.md', nc.join('\n'));
  await upsertText(drive, ids.root, 'ledger.json', `${stableJson(ledger.exportJson())}\n`, 'application/json');
}
