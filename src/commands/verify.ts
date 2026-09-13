import type { DriveApi } from '../apps/types.js';
import { buildLiveDeps } from '../config.js';
import { FetchTransport } from '../integrations/types.js';
import type { Ledger } from '../ledger.js';
import { verifyBinder } from '../integrity/verify.js';
import type { VerifyBinderResult } from '../integrity/verify.js';

// `exhibit verify` (PRD 6.6, 6.14, E64). For the live CLI, deps come from src/config.ts
// buildLiveDeps, per the file-ownership note in this repo's build instructions: the reviewer wires
// this into src/cli.ts as a subcommand. For tests, deps are injected directly.

export interface VerifyCliDeps {
  drive: DriveApi;
  ledger: Ledger;
  binderRoot: string;
  blockHeaders: (height: number) => Promise<string | null>;
  close?: () => Promise<void>;
}

interface BlockstreamBlock {
  merkle_root?: string;
}

/** Live block-header lookup (blockstream.info's public REST API, no key). Not part of the PRD 6.14 table; needed only so `exhibit verify` can independently check a Bitcoin attestation live. */
function liveBlockHeaders(): (height: number) => Promise<string | null> {
  const transport = new FetchTransport();
  return async (height: number) => {
    try {
      const hashRes = await transport.request({ method: 'GET', url: `https://blockstream.info/api/block-height/${height}` });
      if (hashRes.status >= 400) return null;
      const hash = hashRes.body.trim();
      const blockRes = await transport.request({ method: 'GET', url: `https://blockstream.info/api/block/${hash}` });
      if (blockRes.status >= 400) return null;
      const block = JSON.parse(blockRes.body) as BlockstreamBlock;
      return block.merkle_root ?? null;
    } catch {
      return null;
    }
  };
}

async function liveVerifyDeps(): Promise<VerifyCliDeps> {
  const { deps, close } = await buildLiveDeps(process.env);
  const raw = deps.ledger.get('binder');
  if (!raw) throw new Error('exhibit verify: no binder found in the ledger (has Exhibit run yet?)');
  const binderRoot = (JSON.parse(raw) as { root: string }).root;
  return { drive: deps.apps.drive, ledger: deps.ledger, binderRoot, blockHeaders: liveBlockHeaders(), close };
}

function renderTable(result: VerifyBinderResult): string {
  const lines: string[] = [];
  lines.push(`Files checked: ${result.files_checked.length}`);
  lines.push(`  confirmed: ${result.passed.length}`);
  lines.push(`  pending:   ${result.pending.length}`);
  lines.push(`  failed:    ${result.failed.length}`);
  if (result.pending.length) {
    lines.push('', 'Pending (Bitcoin attestation not yet confirmed):');
    for (const p of result.pending) lines.push(`  - ${p}`);
  }
  if (result.failed.length) {
    lines.push('', 'FAILED:');
    for (const f of result.failed) lines.push(`  - ${f.path}: ${f.reason}`);
  }
  return lines.join('\n');
}

/** Returns the process exit code (0 clean, 1 any failure) so the caller decides whether to actually exit. */
export async function cmdVerify(_argv: string[], injected?: VerifyCliDeps): Promise<number> {
  const deps = injected ?? (await liveVerifyDeps());
  try {
    const result = await verifyBinder({ drive: deps.drive, ledger: deps.ledger, binderRoot: deps.binderRoot, blockHeaders: deps.blockHeaders });
    console.log(renderTable(result));
    return result.failed.length > 0 ? 1 : 0;
  } finally {
    await deps.close?.();
  }
}

// Allow running directly: `node --experimental-strip-types src/commands/verify.ts`.
if (process.argv[1] && process.argv[1].endsWith('verify.ts')) {
  cmdVerify(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
