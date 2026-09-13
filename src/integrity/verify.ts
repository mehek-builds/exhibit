import type { DriveApi, DriveFile } from '../apps/types.js';
import { FOLDER_MIME } from '../apps/types.js';
import type { Ledger } from '../ledger.js';
import type { RuleOptions } from '../rules/explicit.js';
import { sha256 } from '../util.js';
import { decodeOts } from './ots.js';
import { verifyProof } from './opentimestamps.js';
import type { VerifyOptions } from './opentimestamps.js';

// `exhibit verify` (PRD 6.14 "exhibit verify", E64): re-checks every filed artifact against its
// recorded hash and its .ots proof, naming any file whose bytes changed since it was stamped.

const STAMPABLE_ROLES = new Set(['original', 'render', 'member', 'signed_letter', 'translation']);

export interface VerifyBinderResult {
  files_checked: string[];
  pending: string[];
  passed: string[];
  failed: { path: string; reason: string }[];
}

interface OtsKvRecord {
  sha256: string;
  ots_file_id: string;
  status: 'pending' | 'confirmed' | 'failed';
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

async function pathOf(drive: DriveApi, file: DriveFile): Promise<string> {
  // Best effort: DriveApi has no getById-by-parent-name walk, so we fall back to the file's own name
  // when a full path can't be reconstructed from the interface available here.
  void drive;
  return file.name;
}

export interface VerifyBinderOptions {
  drive: DriveApi;
  ledger: Ledger;
  binderRoot: string;
  blockHeaders: VerifyOptions['blockHeaders'];
  /** Mutation check only (PRD 12.2): rule ids switched off. Never set from live configuration. */
  ruleOptions?: RuleOptions;
}

export async function verifyBinder(opts: VerifyBinderOptions): Promise<VerifyBinderResult> {
  const { drive, ledger, binderRoot, blockHeaders } = opts;
  const tamperCheckDisabled = (opts.ruleOptions?.disabled ?? []).includes('X-integrity-tamper-check');
  const files = (await walkFiles(drive, binderRoot)).filter((f) => STAMPABLE_ROLES.has(f.appProperties?.role ?? ''));

  const result: VerifyBinderResult = { files_checked: [], pending: [], passed: [], failed: [] };
  for (const file of files) {
    const path = await pathOf(drive, file);
    result.files_checked.push(path);
    const raw = ledger.get(`ots:${file.id}`);
    if (!raw) {
      result.failed.push({ path, reason: 'no .ots proof was ever recorded for this file' });
      continue;
    }
    const record = JSON.parse(raw) as OtsKvRecord;
    const bytes = await drive.readFile(file.id);
    const currentHash = sha256(bytes);
    if (!tamperCheckDisabled && currentHash !== record.sha256) {
      result.failed.push({ path, reason: `bytes changed since stamping: recorded ${record.sha256}, now ${currentHash}` });
      continue;
    }
    let otsBytes: Uint8Array;
    try {
      otsBytes = await drive.readFile(record.ots_file_id);
    } catch {
      result.failed.push({ path, reason: `.ots proof file (${record.ots_file_id}) is missing` });
      continue;
    }
    const proof = decodeOts(otsBytes);
    const verdict = await verifyProof(proof, bytes, { blockHeaders });
    if (verdict.status === 'confirmed') result.passed.push(path);
    else if (verdict.status === 'pending') result.pending.push(path);
    else result.failed.push({ path, reason: verdict.reason ?? 'proof did not verify' });
  }

  ledger.event({
    run_id: 'verify',
    trace_id: null,
    kind: 'verify',
    detail: { files_checked: result.files_checked.length, passed: result.passed.length, failed: result.failed },
    at: new Date().toISOString(),
  });
  return result;
}
