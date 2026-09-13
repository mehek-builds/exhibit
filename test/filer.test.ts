import { describe, expect, it } from 'vitest';
import { CRITERION_FOLDERS, ensureBinder, fileVerified, writeBinderIndexes } from '../src/binder/filer.js';
import type { BinderIds, FilerDeps } from '../src/binder/filer.js';
import { Ledger } from '../src/ledger.js';
import { LocalTracer } from '../src/observability/tracer.js';
import { mapping as mkMapping } from '../src/rules/explicit.js';
import { sha256 } from '../src/util.js';
import { MemoryTwins } from '../src/twins/memory.js';
import type { SourceRef, VerifiedItem } from '../src/types.js';
import { NOW, seed } from '../harness/corpus.js';
import { item, PROFILE } from './helpers.js';

async function makeDeps(): Promise<{ deps: FilerDeps; twins: MemoryTwins; ledger: Ledger }> {
  const twins = new MemoryTwins(seed({}), { now: () => NOW });
  const ledger = new Ledger(':memory:');
  const tracer = new LocalTracer(null);
  const trace = (await tracer.run({ name: 'test', runId: 'r1', input: {} }, async (c) => c)).result;
  const deps: FilerDeps = { drive: twins.apps.drive, ledger, trace, profile: PROFILE, runId: 'r1', now: NOW };
  return { deps, twins, ledger };
}

function verifiedFor(opts: {
  key: string;
  criteria?: number[];
  status?: 'qualifying' | 'needs_attorney' | 'rejected' | 'building';
  ruleId?: string;
  sources: SourceRef[];
  raw?: string;
  title?: string;
}): VerifiedItem {
  const criteria = (opts.criteria ?? [1]) as never;
  const m = mkMapping(criteria, opts.status ?? 'qualifying', opts.ruleId ?? 'C1-award-competitive', 'reason text', 'quote text');
  const primary = item({ app: 'gmail', id: opts.sources[0]!.id, title: opts.title ?? 'Winner: Example Award', raw: opts.raw ?? 'RAW EML CONTENT' });
  return {
    key: opts.key,
    mapping: m,
    title: opts.title ?? 'Winner: Example Award',
    issuer: 'launchfest.example',
    event_date: '2026-04-11',
    url: null,
    sources: opts.sources,
    primary,
    members: [primary],
    checks: [],
    metrics: {},
    highlights: ['Dara Voss'],
    people: [],
  };
}

describe('filer: writes original + render.pdf + metadata.json under the correct criterion folder', () => {
  it('files a qualifying criterion-1 item into 01-awards', async () => {
    const { deps } = await makeDeps();
    const ids = await ensureBinder(deps);
    const v = verifiedFor({ key: 'k1', sources: [{ app: 'gmail', id: 'm-award', url: null }] });
    const rec = await fileVerified(v, ids, deps);
    expect(rec).not.toBeNull();
    expect(rec!.artifact_path.startsWith(CRITERION_FOLDERS['1']!)).toBe(true);

    const exFolder = await deps.drive.findChild(ids.folders['1']!, rec!.exhibit_id);
    expect(exFolder).not.toBeNull();
    const children = await deps.drive.listChildren(exFolder!.id);
    const names = children.map((c) => c.name);
    expect(names).toContain('original.eml');
    expect(names).toContain('render.pdf');
    expect(names).toContain('metadata.json');
  });
});

describe('filer: sha256 of the stored original matches the sha256 of the input bytes', () => {
  it('the record sha256 equals sha256(rawBytes)', async () => {
    const { deps } = await makeDeps();
    const ids = await ensureBinder(deps);
    const raw = 'RAW EML CONTENT FOR HASH CHECK';
    const v = verifiedFor({ key: 'k2', sources: [{ app: 'gmail', id: 'm-hash', url: null }], raw });
    const rec = await fileVerified(v, ids, deps);
    expect(rec!.sha256).toBe(sha256(Buffer.from(raw, 'utf8')));
  });
});

describe('filer: re-filing the identical VerifiedItem is idempotent (E18)', () => {
  it('does not duplicate or corrupt the exhibit on a second identical run', async () => {
    const { deps } = await makeDeps();
    const ids = await ensureBinder(deps);
    const v = verifiedFor({ key: 'k3', sources: [{ app: 'gmail', id: 'm-idem', url: null }] });
    const first = await fileVerified(v, ids, deps);
    const second = await fileVerified(v, ids, deps);
    expect(second!.exhibit_id).toBe(first!.exhibit_id);
    expect(second!.version).toBe(1);

    const exFolder = await deps.drive.findChild(ids.folders['1']!, first!.exhibit_id);
    const children = await deps.drive.listChildren(exFolder!.id);
    // exactly one of each: original, render.pdf, metadata.json -- no duplicates from the second run.
    expect(children.filter((c) => c.name === 'original.eml')).toHaveLength(1);
    expect(children.filter((c) => c.name === 'metadata.json')).toHaveLength(1);
    expect(deps.ledger.exhibits()).toHaveLength(1);
  });
});

describe('filer: adding a new corroborating source creates metadata.v2.json without mutating the original', () => {
  it('supersedes v1 in the ledger and leaves the original file bytes untouched', async () => {
    const { deps } = await makeDeps();
    const ids = await ensureBinder(deps);
    const raw = 'ORIGINAL RAW BYTES, NEVER TO CHANGE';
    const v1 = verifiedFor({ key: 'k4', sources: [{ app: 'gmail', id: 'm-v1', url: null }], raw });
    const rec1 = await fileVerified(v1, ids, deps);
    expect(rec1!.version).toBe(1);

    const exFolder = (await deps.drive.findChild(ids.folders['1']!, rec1!.exhibit_id))!;
    const originalBefore = (await deps.drive.listChildren(exFolder.id)).find((c) => c.name === 'original.eml')!;
    const bytesBefore = await deps.drive.readFile(originalBefore.id);

    // Same key, same status, but a new source link added (a corroborating source).
    const v2 = verifiedFor({ key: 'k4', sources: [{ app: 'gmail', id: 'm-v1', url: null }, { app: 'linkedin', id: 'li-corroborate', url: null }], raw });
    const rec2 = await fileVerified(v2, ids, deps);
    expect(rec2!.version).toBe(2);
    expect(rec2!.exhibit_id).toBe(`${rec1!.exhibit_id}.v2`);
    expect(rec2!.supersedes).toBe(rec1!.exhibit_id);

    const children = await deps.drive.listChildren(exFolder.id);
    expect(children.map((c) => c.name)).toContain('metadata.v2.json');

    const originalAfter = children.find((c) => c.name === 'original.eml')!;
    const bytesAfter = await deps.drive.readFile(originalAfter.id);
    expect(Buffer.from(bytesAfter).equals(Buffer.from(bytesBefore))).toBe(true);
    expect(originalAfter.sha256).toBe(originalBefore.sha256);

    // The ledger's "current" record for this key is the new version; v1 is superseded.
    const current = deps.ledger.exhibitByKey('k4');
    expect(current!.exhibit_id).toBe(rec2!.exhibit_id);
  });
});

describe('filer: nothing filed is ever shared externally', () => {
  it('the binder root and criterion folders carry only an owner permission', async () => {
    const { deps } = await makeDeps();
    const ids = await ensureBinder(deps);
    const rootPerms = await deps.drive.listPermissions(ids.root);
    expect(rootPerms.every((p) => p.role === 'owner')).toBe(true);
    expect(rootPerms.every((p) => !p.emailAddress || p.emailAddress.toLowerCase() === PROFILE.emails[0]!.toLowerCase())).toBe(true);
  });
});

describe('filer: binder-level indexes regenerate correctly from ledger state', () => {
  it('index.md lists qualifying exhibits under their criterion heading and not-counted.md groups rejects by rule', async () => {
    const { deps } = await makeDeps();
    const ids = await ensureBinder(deps);

    const qualified = verifiedFor({ key: 'kq', sources: [{ app: 'gmail', id: 'm-q', url: null }], title: 'Winner: Launchfest 2026' });
    const recQ = await fileVerified(qualified, ids, deps);
    deps.ledger.upsertCandidate({
      key: qualified.key, status: 'qualifying', eb1a_status: 'qualifying', criteria: [1] as never, mapping: qualified.mapping,
      title: qualified.title, issuer: qualified.issuer, event_date: qualified.event_date, url: null, sources: qualified.sources,
      checks: [], exhibit_id: recQ!.exhibit_id, updated_run: 'r1',
    });

    const rejMapping = mkMapping([3] as never, 'rejected', 'T-press-release', 'A press release is not published material.', 'quote');
    deps.ledger.upsertCandidate({
      key: 'krej', status: 'rejected', eb1a_status: 'rejected', criteria: [3] as never, mapping: rejMapping,
      title: 'Distributed: Launch announcement', issuer: 'prwire.example', event_date: '2026-08-20', url: null, sources: [],
      checks: [], exhibit_id: null, updated_run: 'r1',
    });

    await writeBinderIndexes(ids, deps);
    const indexFile = await deps.drive.findChild(ids.root, 'index.md');
    const ncFile = await deps.drive.findChild(ids.root, 'not-counted.md');
    const ledgerFile = await deps.drive.findChild(ids.root, 'ledger.json');
    expect(indexFile).not.toBeNull();
    expect(ncFile).not.toBeNull();
    expect(ledgerFile).not.toBeNull();

    const indexText = Buffer.from(await deps.drive.readFile(indexFile!.id)).toString('utf8');
    expect(indexText).toContain(recQ!.exhibit_id);
    expect(indexText).toContain('Winner: Launchfest 2026');

    const ncText = Buffer.from(await deps.drive.readFile(ncFile!.id)).toString('utf8');
    expect(ncText).toContain('T-press-release');
    expect(ncText).toContain('Distributed: Launch announcement');

    const ledgerJson = JSON.parse(Buffer.from(await deps.drive.readFile(ledgerFile!.id)).toString('utf8'));
    expect(ledgerJson.exhibits.some((e: { exhibit_id: string }) => e.exhibit_id === recQ!.exhibit_id)).toBe(true);
    expect(ledgerJson.candidates).toHaveLength(2);
  });
});
