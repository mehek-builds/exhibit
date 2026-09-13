import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdVerify, verifyExportedDemo } from '../src/commands/verify.js';
import { createIntegrityFixtures } from '../harness/fixtures/integrity.js';
import { encodeOts } from '../src/integrity/ots.js';
import { stampDigest } from '../src/integrity/opentimestamps.js';
import { FixtureTransport } from '../src/integrations/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, '..', 'bin', 'exhibit.mjs');

describe('exported demo verification fails closed', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeExport(manifest?: unknown): { outDir: string; binder: string } {
    const outDir = mkdtempSync(join(tmpdir(), 'exhibit-demo-invalid-'));
    tempDirs.push(outDir);
    const binder = join(outDir, 'drive', 'Exhibit binder');
    mkdirSync(binder, { recursive: true });
    if (manifest !== undefined) {
      writeFileSync(join(outDir, 'integrity-chain.json'), `${JSON.stringify(manifest)}\n`);
    }
    return { outDir, binder };
  }

  it.each([
    ['missing manifest', undefined],
    ['wrong kind', { kind: 'bitcoin', roots: {}, artifacts: ['file.eml'] }],
    ['array roots', { kind: 'synthetic-fixture', roots: [], artifacts: ['file.eml'] }],
    ['missing artifacts', { kind: 'synthetic-fixture', roots: {} }],
    ['empty artifacts', { kind: 'synthetic-fixture', roots: {}, artifacts: [] }],
  ])('rejects a %s', async (_label, manifest) => {
    const { outDir } = makeExport(manifest);
    await expect(verifyExportedDemo(outDir)).rejects.toThrow(/manifest|proofs/i);
  });

  it('rejects malformed JSON in the manifest', async () => {
    const { outDir } = makeExport({ kind: 'synthetic-fixture', roots: {}, artifacts: ['file.eml'] });
    writeFileSync(join(outDir, 'integrity-chain.json'), '{bad json');
    await expect(verifyExportedDemo(outDir)).rejects.toThrow();
  });

  it('rejects paths that escape the binder', async () => {
    const { outDir } = makeExport({ kind: 'synthetic-fixture', roots: {}, artifacts: ['../outside.eml'] });
    await expect(verifyExportedDemo(outDir)).rejects.toThrow(/invalid artifact path/);
  });

  it('reports missing artifacts and missing adjacent proofs as failures', async () => {
    const artifacts = ['missing.eml', 'without-proof.eml'];
    const { outDir, binder } = makeExport({ kind: 'synthetic-fixture', roots: {}, artifacts });
    writeFileSync(join(binder, 'without-proof.eml'), 'evidence');

    const result = await verifyExportedDemo(outDir);

    expect(result.files_checked).toEqual(artifacts);
    expect(result.failed).toEqual([
      { path: 'missing.eml', reason: 'artifact is missing from the exported binder' },
      { path: 'without-proof.eml', reason: 'proof is missing at without-proof.eml.ots' },
    ]);
  });

  it('reports corrupt proof bytes instead of passing them', async () => {
    const { outDir, binder } = makeExport({ kind: 'synthetic-fixture', roots: {}, artifacts: ['file.eml'] });
    writeFileSync(join(binder, 'file.eml'), 'evidence');
    writeFileSync(join(binder, 'file.eml.ots'), 'not an ots proof');

    const result = await verifyExportedDemo(outDir);

    expect(result.passed).toEqual([]);
    expect(result.failed[0]).toMatchObject({ path: 'file.eml' });
    expect(result.failed[0]!.reason).toMatch(/proof could not be read/);
  });

  it('returns one when a valid proof is still pending', async () => {
    const { outDir, binder } = makeExport({ kind: 'synthetic-fixture', roots: {}, artifacts: ['file.eml'] });
    const bytes = Buffer.from('pending evidence');
    const fixtures = createIntegrityFixtures();
    const { proof } = await stampDigest(createHash('sha256').update(bytes).digest('hex'), {
      transport: new FixtureTransport(fixtures.fixtures),
      calendars: ['https://a.pool.opentimestamps.org'],
    });
    writeFileSync(join(binder, 'file.eml'), bytes);
    writeFileSync(join(binder, 'file.eml.ots'), encodeOts(proof));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await verifyExportedDemo(outDir);
    expect(result.pending).toEqual(['file.eml']);
    await expect(cmdVerify(['--demo', outDir])).resolves.toBe(1);
  });

  it('fails a timestamp proof whose artifact was removed from the manifest', async () => {
    const { outDir, binder } = makeExport({ kind: 'synthetic-fixture', roots: {}, artifacts: ['listed.eml'] });
    mkdirSync(join(binder, 'sub'), { recursive: true });
    writeFileSync(join(binder, 'listed.eml'), 'evidence');
    writeFileSync(join(binder, 'sub', 'unlisted.eml'), 'tampered');
    writeFileSync(join(binder, 'sub', 'unlisted.eml.ots'), 'proof bytes');

    const result = await verifyExportedDemo(outDir);

    expect(result.files_checked).toContain('sub/unlisted.eml');
    expect(result.failed).toContainEqual({ path: 'sub/unlisted.eml', reason: 'timestamp proof exists but the artifact is not listed in the synthetic chain manifest' });
  });

  it('finishes on a symlink loop and does not follow symlinks into proofs', async () => {
    const { outDir, binder } = makeExport({ kind: 'synthetic-fixture', roots: {}, artifacts: ['listed.eml'] });
    writeFileSync(join(binder, 'listed.eml'), 'evidence');
    mkdirSync(join(binder, 'a'), { recursive: true });
    symlinkSync(binder, join(binder, 'a', 'up'), 'dir');
    symlinkSync(join(binder, 'a'), join(binder, 'loop'), 'dir');

    const result = await verifyExportedDemo(outDir);

    expect(result.passed).toEqual([]);
    expect(result.failed.map((f) => f.path)).toEqual(['listed.eml']);
  }, 5000);

  it('returns one from cmdVerify and the package binary for malformed exports without live credentials', async () => {
    const { outDir, binder } = makeExport({ kind: 'synthetic-fixture', roots: {}, artifacts: ['file.eml'] });
    writeFileSync(join(binder, 'file.eml'), 'evidence');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(cmdVerify(['--demo', outDir])).resolves.toBe(1);

    expect(() => execFileSync(process.execPath, [binPath, 'verify', '--demo', outDir], {
      cwd: outDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '' },
    })).toThrow();
  });
});
import { createHash } from 'node:crypto';
