import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyExportedDemo } from '../src/commands/verify.js';
import { createIntegrityFixtures } from '../harness/fixtures/integrity.js';
import { FixtureTransport } from '../src/integrations/types.js';
import { encodeOts } from '../src/integrity/ots.js';
import { stampDigest, upgrade } from '../src/integrity/opentimestamps.js';

// Regression: ISSUE-003 - the documented offline verify command required live credentials instead of reading the demo export
// Found by /qa on 2026-09-14
// Report: .gstack/qa-reports/qa-report-localhost-2026-09-14.md

describe('exported demo verification', () => {
  it('confirms untouched files and names a file changed after stamping', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'exhibit-demo-verify-'));
    const binder = join(outDir, 'drive', 'Exhibit binder', '01-awards', 'EX-1-001');
    mkdirSync(binder, { recursive: true });

    const fixtures = createIntegrityFixtures();
    const transport = new FixtureTransport(fixtures.fixtures);
    const files = [
      { name: 'clean.eml', stamped: Buffer.from('untouched evidence'), current: Buffer.from('untouched evidence') },
      { name: 'changed.eml', stamped: Buffer.from('original evidence'), current: Buffer.from('altered evidence') },
    ];
    const pending = [];
    for (const file of files) {
      const digest = createHash('sha256').update(file.stamped).digest('hex');
      const { proof } = await stampDigest(digest, { transport, calendars: ['https://a.pool.opentimestamps.org'] });
      pending.push({ file, proof });
    }

    fixtures.markUpgraded();
    const roots: Record<string, string> = {};
    for (const entry of pending) {
      const { proof } = await upgrade(entry.proof, { transport });
      writeFileSync(join(binder, entry.file.name), entry.file.current);
      writeFileSync(join(binder, `${entry.file.name}.ots`), encodeOts(proof));
      for (const path of proof.paths) {
        if (path.attestation.kind !== 'bitcoin') continue;
        const root = await fixtures.blockHeaders(path.attestation.height);
        if (root) roots[String(path.attestation.height)] = root;
      }
    }
    writeFileSync(join(outDir, 'integrity-chain.json'), `${JSON.stringify({ kind: 'synthetic-fixture', roots }, null, 2)}\n`);

    const result = await verifyExportedDemo(outDir);

    expect(result.files_checked).toHaveLength(2);
    expect(result.passed).toEqual(['01-awards/EX-1-001/clean.eml']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.path).toBe('01-awards/EX-1-001/changed.eml');
    expect(result.failed[0]!.reason).toMatch(/file bytes do not match the stamped digest/);
  });
});
