import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import type { DriveApi } from '../apps/types.js';
import { buildLiveDeps } from '../config.js';
import { FetchTransport } from '../integrations/types.js';
import type { Ledger } from '../ledger.js';
import { verifyBinder } from '../integrity/verify.js';
import type { VerifyBinderResult } from '../integrity/verify.js';
import { decodeOts } from '../integrity/ots.js';
import { verifyProof } from '../integrity/opentimestamps.js';

// `exhibit verify` (PRD 6.6, 6.14, E64). Live dependencies come from src/config.ts;
// tests can inject the same interface directly.

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
  artifacts: string[];
}

/** Verifies a demo export against the synthetic chain roots written by `exhibit demo`. */
export async function verifyExportedDemo(outDir: string): Promise<VerifyBinderResult> {
  const binderRoot = join(outDir, 'drive', 'Exhibit binder');
  const chainPath = join(outDir, 'integrity-chain.json');
  if (!existsSync(binderRoot)) throw new Error(`exhibit verify --demo: binder not found at ${binderRoot}. Run \`exhibit demo --out ${outDir}\` first.`);
  if (!existsSync(chainPath)) throw new Error(`exhibit verify --demo: synthetic chain manifest not found at ${chainPath}. Re-run \`exhibit demo --out ${outDir}\` with this version.`);

  const chain = JSON.parse(readFileSync(chainPath, 'utf8')) as DemoChain;
  if (
    chain.kind !== 'synthetic-fixture'
    || !chain.roots
    || typeof chain.roots !== 'object'
    || Array.isArray(chain.roots)
    || !Array.isArray(chain.artifacts)
    || chain.artifacts.length === 0
    || chain.artifacts.some((path) => typeof path !== 'string' || path.length === 0)
  ) {
    throw new Error(`exhibit verify --demo: invalid synthetic chain manifest at ${chainPath}.`);
  }

  const result: VerifyBinderResult = { files_checked: [], pending: [], passed: [], failed: [] };
  const binderBoundary = `${resolve(binderRoot)}${sep}`;
  const artifacts = [...new Set(chain.artifacts)].sort();
  for (const displayPath of artifacts) {
    const artifactPath = resolve(binderRoot, displayPath);
    if (isAbsolute(displayPath) || !artifactPath.startsWith(binderBoundary)) {
      throw new Error(`exhibit verify --demo: invalid artifact path '${displayPath}' in ${chainPath}.`);
    }
    const proofPath = `${artifactPath}.ots`;
    result.files_checked.push(displayPath);
    if (!existsSync(artifactPath)) {
      result.failed.push({ path: displayPath, reason: 'artifact is missing from the exported binder' });
      continue;
    }
    if (!existsSync(proofPath)) {
      result.failed.push({ path: displayPath, reason: `proof is missing at ${relative(binderRoot, proofPath)}` });
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
  // Fail closed on proofs the manifest doesn't list: deleting a tampered file's manifest entry must
  // not make verify skip it.
  const listed = new Set(artifacts);
  // Walk by hand and never follow symlinks: a crafted export with a symlink loop must not hang verify.
  const proofs: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), childRel);
      else if (entry.isFile() && entry.name.endsWith('.ots')) proofs.push(childRel);
    }
  };
  walk(binderRoot, '');
  proofs.sort();
  for (const proof of proofs) {
    const artifact = proof.slice(0, -'.ots'.length);
    if (listed.has(artifact)) continue;
    result.files_checked.push(artifact);
    result.failed.push({ path: artifact, reason: 'timestamp proof exists but the artifact is not listed in the synthetic chain manifest' });
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
    return result.failed.length > 0 || result.pending.length > 0 ? 1 : 0;
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
