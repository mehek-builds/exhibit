import type { AgentExtension, ExtensionContext } from '../agent.js';
import type { DriveApi, DriveFile } from '../apps/types.js';
import { FOLDER_MIME } from '../apps/types.js';
import type { HttpTransport } from '../integrations/types.js';
import { sha256 } from '../util.js';
import { archivePage } from './archive.js';
import { decodeOts, encodeOts } from './ots.js';
import { DEFAULT_CALENDARS, stampDigest, upgrade } from './opentimestamps.js';

// The tamper-evident binder as an AgentExtension (PRD 6.6, 6.14, 6.12.3 S22). Runs at two fixed
// points in the pipeline: afterFiling stamps every artifact filed this run (and upgrades every
// still-pending proof, every run -- the "nightly job"); afterReview archives the public source pages
// of figures approved this run. Both are best-effort: a failure here degrades the extension, never
// the run (agent.ts eachExtension already isolates extension errors).

const STAMPABLE_ROLES = new Set(['original', 'render', 'member', 'signed_letter', 'translation']);

export interface IntegrityExtensionOptions {
  transport: HttpTransport;
  calendars?: string[];
  archiveKeys?: { accessKey: string; secretKey: string };
  /** Maps a Bitcoin block height to that block's merkle root (hex); required for `exhibit verify`, not for stamping itself. */
  blockHeaders?: (height: number) => Promise<string | null>;
}

interface OtsKvRecord {
  sha256: string;
  ots_file_id: string;
  status: 'pending' | 'confirmed' | 'failed';
  calendars: string[];
  bitcoin_height?: number;
}

async function walkFiles(drive: DriveApi, rootId: string): Promise<DriveFile[]> {
  const out: DriveFile[] = [];
  const queue = [rootId];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const child of await drive.listChildren(parent)) {
      if (child.mimeType === FOLDER_MIME) queue.push(child.id);
      else out.push(child);
    }
  }
  return out;
}

export function createIntegrityExtension(opts: IntegrityExtensionOptions): AgentExtension {
  const calendars = opts.calendars ?? DEFAULT_CALENDARS;

  async function stampFile(ctx: ExtensionContext, file: DriveFile): Promise<void> {
    const kvKey = `ots:${file.id}`;
    if (ctx.deps.ledger.get(kvKey)) return; // already stamped
    const exhibitId = file.appProperties?.exhibit_id ?? null;
    const { proof, errors } = await stampDigest(file.sha256 ?? sha256(await ctx.deps.apps.drive.readFile(file.id)), { transport: opts.transport, calendars });
    if (proof.paths.length === 0) {
      ctx.trace.tool('opentimestamps.digest', { file_id: file.id }, undefined, errors.join('; '));
      return; // no calendar accepted the digest this run; retried next run since kv is unset
    }
    const otsBytes = encodeOts(proof);
    const otsFile = await ctx.deps.apps.drive.createFile({
      parentId: file.parents[0]!,
      name: `${file.name}.ots`,
      mimeType: 'application/vnd.opentimestamps.ots',
      content: otsBytes,
      appProperties: { exhibit_id: exhibitId ?? '', role: 'ots', for_file_id: file.id },
    });
    const record: OtsKvRecord = { sha256: bytesHex(proof.digest), ots_file_id: otsFile.id, status: 'pending', calendars };
    ctx.deps.ledger.set(kvKey, JSON.stringify(record));
    ctx.deps.ledger.event({
      run_id: ctx.runId,
      trace_id: ctx.trace.traceId,
      kind: 'timestamp',
      detail: { file_id: file.id, exhibit_id: exhibitId, sha256: record.sha256, ots_file_id: otsFile.id, status: 'pending' },
      at: ctx.now.toISOString(),
    });
    ctx.trace.tool('opentimestamps.stamp', { file_id: file.id, calendars: calendars.length }, { ots_file_id: otsFile.id, paths: proof.paths.length });
  }

  async function upgradePending(ctx: ExtensionContext): Promise<void> {
    // Every kv key `ots:<fileId>` with status pending is a candidate for the nightly upgrade job.
    const keys = ctx.deps.ledger.events({ kind: 'timestamp' }).map((e) => String(e.detail.file_id ?? '')).filter(Boolean);
    const seen = new Set<string>();
    for (const fileId of keys) {
      if (seen.has(fileId)) continue;
      seen.add(fileId);
      const kvKey = `ots:${fileId}`;
      const raw = ctx.deps.ledger.get(kvKey);
      if (!raw) continue;
      const record = JSON.parse(raw) as OtsKvRecord;
      if (record.status !== 'pending') continue;
      const otsBytes = await ctx.deps.apps.drive.readFile(record.ots_file_id);
      const proof = decodeOts(otsBytes);
      const { proof: nextProof, upgraded, errors } = await upgrade(proof, { transport: opts.transport });
      if (errors.length) ctx.trace.tool('opentimestamps.upgrade', { file_id: fileId }, undefined, errors.join('; '));
      if (upgraded === 0) continue;
      await ctx.deps.apps.drive.updateFileContent(record.ots_file_id, encodeOts(nextProof));
      const bitcoinPath = nextProof.paths.find((p) => p.attestation.kind === 'bitcoin');
      const next: OtsKvRecord = { ...record, status: bitcoinPath ? 'confirmed' : 'pending', bitcoin_height: bitcoinPath?.attestation.kind === 'bitcoin' ? bitcoinPath.attestation.height : undefined };
      ctx.deps.ledger.set(kvKey, JSON.stringify(next));
      ctx.deps.ledger.event({
        run_id: ctx.runId,
        trace_id: ctx.trace.traceId,
        kind: 'timestamp',
        detail: { file_id: fileId, ots_file_id: record.ots_file_id, sha256: record.sha256, status: next.status },
        at: ctx.now.toISOString(),
      });
      ctx.trace.tool('opentimestamps.upgrade', { file_id: fileId }, { status: next.status });
    }
  }

  return {
    name: 'integrity',

    async afterFiling(ctx: ExtensionContext, filed): Promise<void> {
      // Stamp every stampable artifact under the binder, not only the exhibits filed this exact run:
      // other extensions (signed letters, translations) may add role files to an exhibit folder on a
      // later run than the one that filed the exhibit itself.
      const files = await walkFiles(ctx.deps.apps.drive, ctx.binder.root);
      for (const file of files) {
        const role = file.appProperties?.role;
        if (role && STAMPABLE_ROLES.has(role)) await stampFile(ctx, file);
      }
      void filed; // filing already covered by the binder walk above
      await upgradePending(ctx); // the "nightly job": every run upgrades whatever is still pending
    },

    async afterReview(ctx: ExtensionContext): Promise<void> {
      if (!opts.archiveKeys) return;
      // Every approved figure, not only ones approved this exact run, so approvals from an earlier
      // degraded run (Internet Archive down) still get archived once it recovers (PRD 10).
      const approvedFigures = ctx.deps.ledger.figures({ status: 'approved' });
      for (const fig of approvedFigures) {
        const figId = fig.fig_id;
        for (const source of fig.sources) {
          if (!/^https?:\/\//.test(source.url)) continue; // public pages only (constraint 17)
          if (ctx.deps.ledger.get(`archived:${source.url}`)) continue;
          const result = await archivePage(source.url, { transport: opts.transport, accessKey: opts.archiveKeys.accessKey, secretKey: opts.archiveKeys.secretKey });
          ctx.deps.ledger.event({
            run_id: ctx.runId,
            trace_id: ctx.trace.traceId,
            kind: 'archive',
            detail: { url: source.url, archive_url: result.archiveUrl, ok: result.ok, fig_id: figId, reason: result.reason },
            at: ctx.now.toISOString(),
          });
          if (result.ok && result.archiveUrl) ctx.deps.ledger.set(`archived:${source.url}`, result.archiveUrl);
          ctx.trace.tool('archive.save_page_now', { url: source.url }, result.ok ? { archive_url: result.archiveUrl } : undefined, result.ok ? undefined : result.reason);
        }
      }
    },
  };
}

function bytesHex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex');
}
