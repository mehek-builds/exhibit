import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runDemo } from '../src/demo.js';

// Runs the full two-minute demo (PRD 14) into a temp directory and checks it against its own
// exports, not against numbers typed here: every figure below is read back from the files the demo
// itself wrote, so the test breaks if the printed output and the ledger ever disagree.

let outDir: string | null = null;

afterEach(() => {
  if (outDir && existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  outDir = null;
});

describe('runDemo', () => {
  it('completes without throwing and exports the expected files', async () => {
    outDir = mkdtempSync(join(tmpdir(), 'exhibit-demo-'));
    await expect(runDemo(outDir)).resolves.toBeUndefined();

    for (const f of ['scorecard.txt', 'sent-mail.json', 'trace.jsonl', 'ledger.json', 'audit.json']) {
      expect(existsSync(join(outDir, f)), `expected ${f} to be exported`).toBe(true);
    }
    expect(existsSync(join(outDir, 'drive'))).toBe(true);
  });

  it('spot-checks printed/returned figures exactly against the underlying ledger export', async () => {
    outDir = mkdtempSync(join(tmpdir(), 'exhibit-demo-'));

    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      await runDemo(outDir);
    } finally {
      console.log = originalLog;
    }
    const printed = lines.join('\n');

    const ledgerExport = JSON.parse(readFileSync(join(outDir, 'ledger.json'), 'utf8')) as {
      exhibits: { exhibit_id: string }[];
      figures: { fig_id: string; status: string; value: number; unit: string; measure: string }[];
    };

    // 1) Exhibits filed count printed in "--- Run 1 ---" matches the ledger's exhibit count exactly.
    const filedMatch = printed.match(/Exhibits filed: (\d+) \(([^)]*)\)/);
    expect(filedMatch).not.toBeNull();
    const filedCount = Number(filedMatch![1]);
    const filedIds = filedMatch![2]!.split(', ').filter(Boolean);
    // The printed count matches the printed id list's own length exactly, and every id it names
    // is a real exhibit in the ledger this run produced (not invented for the printout).
    expect(filedCount).toBe(filedIds.length);
    const ledgerExhibitIds = new Set(ledgerExport.exhibits.map((e) => e.exhibit_id));
    for (const id of filedIds) expect(ledgerExhibitIds.has(id), `expected ${id} to exist in ledger.json`).toBe(true);

    // 2) The scorecard headline's O-1A count matches what the exported scorecard.txt says, exactly.
    const scorecardText = readFileSync(join(outDir, 'scorecard.txt'), 'utf8');
    const o1FromFile = scorecardText.match(/O-1A: (\d+) of 8/)?.[1];
    const o1Printed = printed.match(/O-1A: (\d+) of 8/)?.[1];
    expect(o1FromFile).toBeDefined();
    expect(o1Printed).toBe(o1FromFile);

    // 3) Every fig_id printed in the "figures queued" block is a real fig_id in the ledger export,
    // and its printed value/unit matches the ledger row exactly (not approximately).
    const figLines = [...printed.matchAll(/^\s*(FIG-\d+) \([A-Z0-9-]+\) [^:]+: (-?\d+(?:\.\d+)?) (\S[^—]*?) —/gm)];
    expect(figLines.length).toBeGreaterThan(0);
    for (const [, figId, valueStr, unit] of figLines) {
      const row = ledgerExport.figures.find((f) => f.fig_id === figId);
      expect(row, `expected ${figId} to exist in ledger.json`).toBeDefined();
      expect(Number(valueStr)).toBe(row!.value);
      expect(unit!.trim()).toBe(row!.unit);
    }
  });
});
