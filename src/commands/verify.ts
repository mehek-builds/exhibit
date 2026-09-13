import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import type { DriveApi } from '../apps/types.js';
import { buildLiveDeps } from '../config.js';
import { FetchTransport } from '../integrations/types.js';
import type { Ledger } from '../ledger.js';
import { verifyBinder } from '../integrity/verify.js';
import type { VerifyBinderResult } from '../integrity/verify.js';
import { decodeOts } from '../integrity/ots.js';
import { verifyProof } from '../integrity/opentimestamps.js';

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

interface DemoChain {
  kind: 'synthetic-fixture';
  roots: Record<string, string>;
}

function walkLocalFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkLocalFiles(path));
    else files.push(path);
  }
  return files;
}

/** Verifies a demo export against the synthetic chain roots written by `exhibit demo`. */
export async function verifyExportedDemo(outDir: string): Promise<VerifyBinderResult> {
  const binderRoot = join(outDir, 'drive', 'Exhibit binder');
  const chainPath = join(outDir, 'integrity-chain.json');
  if (!existsSync(binderRoot)) throw new Error(`exhibit verify --demo: binder not found at ${binderRoot}. Run \`exhibit demo --out ${outDir}\` first.`);
  if (!existsSync(chainPath)) throw new Error(`exhibit verify --demo: synthetic chain manifest not found at ${chainPath}. Re-run \`exhibit demo --out ${outDir}\` with this version.`);

  const chain = JSON.parse(readFileSync(chainPath, 'utf8')) as DemoChain;
  if (chain.kind !== 'synthetic-fixture' || !chain.roots || typeof chain.roots !== 'object') {
    throw new Error(`exhibit verify --demo: invalid synthetic chain manifest at ${chainPath}.`);
  }

  const result: VerifyBinderResult = { files_checked: [], pending: [], passed: [], failed: [] };
  const proofs = walkLocalFiles(binderRoot).filter((path) => path.endsWith('.ots')).sort();
  if (proofs.length === 0) throw new Error(`exhibit verify --demo: no .ots proofs found under ${binderRoot}.`);

  for (const proofPath of proofs) {
    const artifactPath = proofPath.slice(0, -'.ots'.length);
    const displayPath = relative(binderRoot, artifactPath);
    result.files_checked.push(displayPath);
    if (!existsSync(artifactPath)) {
      result.failed.push({ path: displayPath, reason: `artifact is missing beside ${relative(binderRoot, proofPath)}` });
      continue;
    }
    try {
      const proof = decodeOts(readFileSync(proofPath));
      const verdict = await verifyProof(proof, readFileSync(artifactPath), {
        blockHeaders: async (height) => chain.roots[String(height)] ?? null,
      });
      if (verdict.status === 'confirmed') result.passed.push(displayPath);
      else if (verdict.status === 'pending') result.pending.push(displayPath);
      else result.failed.push({ path: displayPath, reason: verdict.reason ?? 'proof did not verify' });
    } catch (error) {
      result.failed.push({ path: displayPath, reason: `proof could not be read: ${String(error)}` });
    }
  }
  return result;
}

/** Returns the process exit code (0 clean, 1 any failure) so the caller decides whether to actually exit. */
export async function cmdVerify(argv: string[], injected?: VerifyCliDeps): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { demo: { type: 'string' } } });
  if (values.demo) {
    if (injected) throw new Error('cmdVerify: --demo cannot be combined with injected live dependencies.');
    const result = await verifyExportedDemo(values.demo);
    console.log(`Synthetic demo verification: ${values.demo}`);
    console.log('Uses the fixture chain manifest exported by the demo, not Bitcoin mainnet.');
    console.log(renderTable(result));
    return result.failed.length > 0 ? 1 : 0;
  }
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
