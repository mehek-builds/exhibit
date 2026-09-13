import { createHash } from 'node:crypto';
import type { HttpTransport } from '../integrations/types.js';
import { decodeTimestampProof } from './ots.js';
import type { OtsOp, OtsPath, OtsProof } from './ots.js';

// OpenTimestamps stamping, upgrade and verification (PRD 6.6, 6.14, E63). Only the 32-byte sha256
// digest is ever sent to a calendar (constraint 17) -- never the file itself.
//
// Wire protocol, read from source on 2026-09-13 (raw.githubusercontent.com
// opentimestamps/python-opentimestamps `opentimestamps/calendar.py`, class `RemoteCalendar`):
//   - `submit(digest)`: `POST <calendar>/digest` with the raw digest bytes as the request body and
//     header `Accept: application/vnd.opentimestamps.v1`; response body is a bare serialized
//     `Timestamp` (see ots.ts `decodeTimestampProof`) rooted at that digest.
//   - `get_timestamp(commitment)`: `GET <calendar>/timestamp/<hex(commitment)>`, same Accept header;
//     response body is a bare serialized `Timestamp` rooted at that commitment. A 404 means the
//     calendar doesn't have that commitment (yet) -- `CommitmentNotFoundError` in the reference client
//     -- which we treat the same as "still pending", never an error.
// `RemoteCalendar.submit`'s `urllib.request.Request(..., data=digest, headers=self.request_headers)`
// does not set a Content-Type explicitly in that source file; we send
// `Content-Type: application/x-www-form-urlencoded` (the byte-body convention `otsclient` itself
// documents for calendar submission) since some server-side frameworks reject a POST body with no
// Content-Type at all. This one header is UNCONFIRMED against a live calendar -- see
// docs/integrations/OPENTIMESTAMPS.md.

export const DEFAULT_CALENDARS = ['https://a.pool.opentimestamps.org', 'https://b.pool.opentimestamps.org', 'https://a.pool.eternitywall.com'];

const CALENDAR_HEADERS = { Accept: 'application/vnd.opentimestamps.v1' };

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex');
}

function reverseBytes(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b[b.length - 1 - i]!;
  return out;
}

/** Response bytes, from either `HttpResponse.bytes` (binary-aware transports) or a latin1 fallback for transports that only carry `body: string`. */
function responseBytes(res: { body: string; bytes?: Uint8Array }): Uint8Array {
  if (res.bytes) return res.bytes;
  return new Uint8Array(Buffer.from(res.body, 'latin1'));
}

function applyOp(input: Uint8Array, op: OtsOp): Uint8Array {
  switch (op.kind) {
    case 'append':
      return Buffer.concat([input, op.operand]);
    case 'prepend':
      return Buffer.concat([op.operand, input]);
    case 'reverse':
      return Uint8Array.from(input).reverse();
    case 'hexlify':
      return new TextEncoder().encode(Buffer.from(input).toString('hex'));
    case 'sha1':
      return createHash('sha1').update(input).digest();
    case 'ripemd160':
      return createHash('ripemd160').update(input).digest();
    case 'sha256':
      return createHash('sha256').update(input).digest();
    case 'keccak256':
      // python-opentimestamps computes this with pycryptodome's Keccak (NOT the NIST SHA3-256
      // variant Node's `sha3-256` implements -- the padding differs). No Exhibit code path produces
      // or needs a keccak256 op today (Ethereum attestations aren't used), so rather than ship a
      // mismatched digest we fail loudly if one is ever encountered.
      throw new Error('ots: keccak256 op is not implemented (no Node built-in Keccak-256; only NIST SHA3-256, which is a different digest)');
  }
}

/** Applies a path's ops in order, starting from the file's digest. The result is what the attestation below commits to. */
export function commitmentOf(digest: Uint8Array, ops: OtsOp[]): Uint8Array {
  let cur = digest;
  for (const op of ops) cur = applyOp(cur, op);
  return cur;
}

export interface StampOptions {
  transport: HttpTransport;
  calendars?: string[];
}

/** Submits the digest to each calendar (hash only, constraint 17); merges every calendar's response into one proof tree. */
export async function stampDigest(sha256Hex: string, opts: StampOptions): Promise<{ proof: OtsProof; errors: string[] }> {
  const calendars = opts.calendars ?? DEFAULT_CALENDARS;
  const digest = hexToBytes(sha256Hex);
  const paths: OtsPath[] = [];
  const errors: string[] = [];
  for (const calendar of calendars) {
    // Only the 32 raw digest bytes ever leave the process (constraint 17) -- never the file bytes.
    const res = await opts.transport.request({
      method: 'POST',
      url: `${calendar}/digest`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...CALENDAR_HEADERS },
      body: digest,
    });
    if (res.status >= 400) {
      errors.push(`${calendar}: ${res.status}`);
      continue;
    }
    let newPaths: OtsPath[];
    try {
      newPaths = decodeTimestampProof(responseBytes(res));
    } catch (e) {
      errors.push(`${calendar}: invalid response (${(e as Error).message})`);
      continue;
    }
    if (newPaths.length === 0) {
      errors.push(`${calendar}: empty timestamp in response`);
      continue;
    }
    paths.push(...newPaths);
  }
  return { proof: { digest, paths }, errors };
}

export interface UpgradeOptions {
  transport: HttpTransport;
}

/** Polls every pending path's calendar; a path whose transaction confirmed gets its Bitcoin (or other) attestation merged in. Runs every agent run ("nightly job"). */
export async function upgrade(proof: OtsProof, opts: UpgradeOptions): Promise<{ proof: OtsProof; upgraded: number; errors: string[] }> {
  const errors: string[] = [];
  let upgradedCount = 0;
  const nextPaths: OtsPath[] = [];
  for (const path of proof.paths) {
    if (path.attestation.kind !== 'pending') {
      nextPaths.push(path); // already bitcoin, or an unknown attestation kind we can't poll further
      continue;
    }
    const commitment = commitmentOf(proof.digest, path.ops);
    const url = `${path.attestation.uri}/timestamp/${bytesToHex(commitment)}`;
    const res = await opts.transport.request({ method: 'GET', url, headers: CALENDAR_HEADERS });
    if (res.status === 404) {
      nextPaths.push(path); // CommitmentNotFoundError equivalent (E63): still pending, never an error
      continue;
    }
    if (res.status >= 400) {
      errors.push(`${path.attestation.uri}: ${res.status}`);
      nextPaths.push(path);
      continue;
    }
    let extraPaths: OtsPath[];
    try {
      extraPaths = decodeTimestampProof(responseBytes(res));
    } catch (e) {
      errors.push(`${path.attestation.uri}: invalid response (${(e as Error).message})`);
      nextPaths.push(path);
      continue;
    }
    if (extraPaths.length === 0) {
      nextPaths.push(path); // still pending (E63): never upgraded early
      continue;
    }
    let gotBitcoin = false;
    for (const extra of extraPaths) {
      nextPaths.push({ ops: [...path.ops, ...extra.ops], attestation: extra.attestation });
      if (extra.attestation.kind === 'bitcoin') gotBitcoin = true;
    }
    if (gotBitcoin) upgradedCount += 1;
  }
  return { proof: { digest: proof.digest, paths: nextPaths }, upgraded: upgradedCount, errors };
}

export type ProofStatus = 'confirmed' | 'pending' | 'failed';

export interface VerifyOptions {
  /** Maps a Bitcoin block height to that block's merkle root (hex, in the conventional reversed/display byte order -- e.g. what a block explorer or `bitcoind`'s `getblock` shows), for comparison against the commitment. */
  blockHeaders: (height: number) => Promise<string | null>;
}

export interface VerifyResult {
  status: ProofStatus;
  reason?: string;
  height?: number;
}

/**
 * E63: only a path whose commitment matches its attested block's merkle root is ever 'confirmed'. A
 * pending calendar attestation is always 'pending', never early-confirmed.
 *
 * Per `notary.py` `BitcoinBlockHeaderAttestation.verify_against_blockheader`, the commitment is
 * compared directly against `block_header.hashMerkleRoot` -- which python-bitcoinlib stores and
 * compares in internal (little-endian) byte order. The conventional hex string humans and most
 * block-header sources hand around (RPC `getblock`, block explorers) is the *reversed*, big-endian
 * display order, so we reverse our computed commitment's bytes before comparing it to the hex `merkleRoot`
 * a `blockHeaders` source returns.
 */
export async function verifyProof(proof: OtsProof, fileBytes: Uint8Array, opts: VerifyOptions): Promise<VerifyResult> {
  const actualDigest = createHash('sha256').update(fileBytes).digest();
  if (bytesToHex(actualDigest) !== bytesToHex(proof.digest)) {
    return { status: 'failed', reason: `file bytes do not match the stamped digest (expected ${bytesToHex(proof.digest)}, got ${bytesToHex(actualDigest)})` };
  }
  if (proof.paths.length === 0) return { status: 'failed', reason: 'no calendar paths in proof' };

  let anyPending = false;
  const failures: string[] = [];
  for (const path of proof.paths) {
    if (path.attestation.kind === 'pending') {
      anyPending = true;
      continue;
    }
    if (path.attestation.kind === 'unknown') {
      failures.push(`unrecognized attestation kind (tag ${bytesToHex(path.attestation.tag)}) cannot be verified`);
      continue;
    }
    const commitment = commitmentOf(proof.digest, path.ops);
    const merkleRoot = await opts.blockHeaders(path.attestation.height);
    if (!merkleRoot) {
      failures.push(`block ${path.attestation.height}: unknown to the block-header source`);
      continue;
    }
    if (bytesToHex(reverseBytes(commitment)).toLowerCase() === merkleRoot.toLowerCase()) {
      return { status: 'confirmed', height: path.attestation.height };
    }
    failures.push(`block ${path.attestation.height}: commitment does not match the block's merkle root`);
  }
  if (anyPending) return { status: 'pending' };
  return { status: 'failed', reason: failures.join('; ') || 'no path verified' };
}
