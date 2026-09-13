import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FixtureTransport } from '../src/integrations/types.js';
import { decodeOts, encodeOts } from '../src/integrity/ots.js';
import type { OtsProof } from '../src/integrity/ots.js';
import { archivePage } from '../src/integrity/archive.js';
import { stampDigest, upgrade, verifyProof } from '../src/integrity/opentimestamps.js';
import { verifyBinder } from '../src/integrity/verify.js';
import { createIntegrityFixtures } from '../harness/fixtures/integrity.js';
import { makeS22 } from '../harness/scenarios/s22.js';
import { runScenarioAttempt } from '../harness/runner.js';
import { MemoryTwins } from '../src/twins/memory.js';
import { FOLDER_MIME } from '../src/apps/types.js';
import { Ledger } from '../src/ledger.js';

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

// ---------------- codec round-trip ----------------

describe('ots codec', () => {
  it('round-trips a proof with a pending path', () => {
    const proof: OtsProof = {
      digest: new Uint8Array(createHash('sha256').update('hello exhibit').digest()),
      paths: [{ ops: [{ kind: 'append', operand: Uint8Array.from([1, 2, 3]) }, { kind: 'sha256' }], attestation: { kind: 'pending', uri: 'https://a.pool.opentimestamps.org' } }],
    };
    expect(decodeOts(encodeOts(proof))).toEqual(proof);
  });

  it('round-trips a proof with a bitcoin attestation and multiple paths', () => {
    const digest = new Uint8Array(createHash('sha256').update('another file').digest());
    const proof: OtsProof = {
      digest,
      paths: [
        { ops: [], attestation: { kind: 'bitcoin', height: 912345 } },
        { ops: [{ kind: 'prepend', operand: Uint8Array.from([9, 9]) }, { kind: 'ripemd160' }], attestation: { kind: 'pending', uri: 'https://b.pool.opentimestamps.org' } },
      ],
    };
    expect(decodeOts(encodeOts(proof))).toEqual(proof);
  });

  it('rejects bytes that are not an OpenTimestamps proof (bad header magic)', () => {
    expect(() => decodeOts(new Uint8Array(40))).toThrow(/bad magic/);
  });

  it('rejects a truncated buffer that is too short to even contain the header', () => {
    expect(() => decodeOts(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toThrow(/unexpected end of buffer/);
  });
});

// ---------------- stamp -> pending -> upgrade -> confirmed ----------------

describe('opentimestamps stamp/upgrade/verify cycle', () => {
  it('is pending immediately, then confirmed after the calendar attestation upgrades (E63)', async () => {
    const fixtures = createIntegrityFixtures();
    const transport = new FixtureTransport(fixtures.fixtures);
    const fileBytes = Buffer.from('the exhibit original bytes');
    const digestHex = sha256Hex(fileBytes);

    const { proof, errors } = await stampDigest(digestHex, { transport, calendars: ['https://a.pool.opentimestamps.org'] });
    expect(errors).toEqual([]);
    expect(proof.paths).toHaveLength(1);
    expect(proof.paths[0]!.attestation.kind).toBe('pending');

    // E63: never confirmed before the Bitcoin attestation actually verifies.
    const beforeUpgrade = await verifyProof(proof, fileBytes, { blockHeaders: fixtures.blockHeaders });
    expect(beforeUpgrade.status).toBe('pending');

    fixtures.markUpgraded();
    const { proof: upgraded, upgraded: count } = await upgrade(proof, { transport });
    expect(count).toBe(1);
    expect(upgraded.paths[0]!.attestation.kind).toBe('bitcoin');

    const afterUpgrade = await verifyProof(upgraded, fileBytes, { blockHeaders: fixtures.blockHeaders });
    expect(afterUpgrade.status).toBe('confirmed');
  });

  it('fails when the file bytes changed since stamping (E64)', async () => {
    const fixtures = createIntegrityFixtures();
    const transport = new FixtureTransport(fixtures.fixtures);
    const fileBytes = Buffer.from('original content');
    const digestHex = sha256Hex(fileBytes);
    const { proof } = await stampDigest(digestHex, { transport, calendars: ['https://a.pool.opentimestamps.org'] });
    fixtures.markUpgraded();
    const { proof: upgraded } = await upgrade(proof, { transport });

    const tampered = Buffer.from('tampered content');
    const result = await verifyProof(upgraded, tampered, { blockHeaders: fixtures.blockHeaders });
    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/do not match the stamped digest/);
  });

  it('OpenTimestamps calendars receive only the raw 32-byte digest, never file bytes', async () => {
    // Reference protocol (opentimestamps/calendar.py RemoteCalendar.submit): POST body is the raw
    // digest bytes, not a hex string -- see opentimestamps.ts header comment.
    const fixtures = createIntegrityFixtures();
    const transport = new FixtureTransport(fixtures.fixtures);
    const fileBytes = Buffer.from('secret file contents that must never leave');
    const digestHex = sha256Hex(fileBytes);
    await stampDigest(digestHex, { transport, calendars: ['https://a.pool.opentimestamps.org', 'https://b.pool.opentimestamps.org'] });

    const digestRequests = transport.requests.filter((r) => /\/digest$/.test(r.url));
    expect(digestRequests).toHaveLength(2);
    for (const req of digestRequests) {
      expect(req.body).toBeInstanceOf(Uint8Array);
      const bodyBytes = req.body as Uint8Array;
      expect(bodyBytes.length).toBe(32);
      expect(Buffer.from(bodyBytes).toString('hex')).toBe(digestHex);
      expect(Buffer.from(bodyBytes).toString('latin1')).not.toContain('secret file contents');
    }
  });
});

// ---------------- archive ----------------

describe('archivePage', () => {
  it('sends only the public URL to Save Page Now', async () => {
    const fixtures = createIntegrityFixtures();
    const transport = new FixtureTransport(fixtures.fixtures);
    const url = 'https://devtoolsweekly.example/2026/03/loomwork-dara-voss-flaky-ci';
    const result = await archivePage(url, { transport, accessKey: 'ak', secretKey: 'sk' });
    expect(result.ok).toBe(true);
    expect(result.archiveUrl).toContain('web.archive.org');

    const saveReq = transport.requests.find((r) => r.url === 'https://web.archive.org/save');
    expect(saveReq).toBeTruthy();
    expect(String(saveReq!.body)).toBe(`url=${encodeURIComponent(url)}`);
    expect(String(saveReq!.body)).not.toMatch(/drive\.google|localhost/);
  });

  it('falls back to the availability API, and a full failure is retryable (E65)', async () => {
    const fixtures = createIntegrityFixtures();
    const transport = new FixtureTransport(fixtures.fixtures);
    const url = 'https://shipitpod.example/episodes/212';
    fixtures.rateLimit(url);
    const result = await archivePage(url, { transport, accessKey: 'ak', secretKey: 'sk' });
    // Save Page Now is rate-limited and the availability fallback also has nothing for this URL under rate-limit
    // in this fixture, so the whole thing reports a retryable failure rather than throwing.
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});

// ---------------- verifyBinder against a hand-built binder ----------------

describe('verifyBinder', () => {
  it('passes on an untouched, confirmed artifact and fails naming a tampered one', async () => {
    const twins = new MemoryTwins({ owner: 'dara@loomwork.example', gmail: [], calendar: [], github: {}, linkedin: null }, { now: () => new Date('2026-09-13T00:00:00Z') });
    const drive = twins.apps.drive;
    const ledger = new Ledger(':memory:');
    const root = (await drive.createFolder(null, 'Exhibit binder')).id;
    const good = await drive.createFile({ parentId: root, name: 'original.eml', mimeType: 'message/rfc822', content: 'good file', appProperties: { exhibit_id: 'EX-1-001', role: 'original' } });
    const bad = await drive.createFile({ parentId: root, name: 'original.eml', mimeType: 'message/rfc822', content: 'bad file', appProperties: { exhibit_id: 'EX-1-002', role: 'original' } });
    void FOLDER_MIME;

    const fixtures = createIntegrityFixtures();
    const transport = new FixtureTransport(fixtures.fixtures);
    for (const file of [good, bad]) {
      const { proof } = await stampDigest(file.sha256!, { transport, calendars: ['https://a.pool.opentimestamps.org'] });
      const otsFile = await drive.createFile({ parentId: root, name: `${file.name}.ots.${file.id}`, mimeType: 'application/vnd.opentimestamps.ots', content: encodeOts(proof) });
      ledger.set(`ots:${file.id}`, JSON.stringify({ sha256: file.sha256, ots_file_id: otsFile.id, status: 'pending' }));
    }
    fixtures.markUpgraded();
    for (const file of [good, bad]) {
      const raw = JSON.parse(ledger.get(`ots:${file.id}`)!) as { ots_file_id: string };
      const proof = decodeOts(await drive.readFile(raw.ots_file_id));
      const { proof: upgraded } = await upgrade(proof, { transport });
      await drive.updateFileContent(raw.ots_file_id, encodeOts(upgraded));
      ledger.set(`ots:${file.id}`, JSON.stringify({ sha256: file.sha256, ots_file_id: raw.ots_file_id, status: 'confirmed' }));
    }

    twins.adminOverwriteFile(bad.id, 'this is not what was stamped');

    const result = await verifyBinder({ drive, ledger, binderRoot: root, blockHeaders: fixtures.blockHeaders });
    expect(result.files_checked).toHaveLength(2);
    expect(result.passed).toEqual([good.name]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.path).toBe(bad.name);
    expect(result.failed[0]!.reason).toMatch(/bytes changed/);
    ledger.close();
  });
});

// ---------------- S22 end to end ----------------

describe('S22 integrity scenario', () => {
  it('passes once via runScenarioAttempt', async () => {
    const r = await runScenarioAttempt(makeS22(), 1);
    if (!r.passed) {
      const failing = r.checks.filter((c) => !c.pass).map((c) => `${c.name}: ${c.detail}`);
      throw new Error(`S22 failed: ${r.error ?? ''}\n${failing.join('\n')}\nside effects: ${JSON.stringify(r.sideEffects)}`);
    }
    expect(r.passed).toBe(true);
  }, 60_000);
});
