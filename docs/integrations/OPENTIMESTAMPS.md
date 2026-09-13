# OpenTimestamps integration

PRD 6.6 ("every filed artifact is stamped with OpenTimestamps and anchored in Bitcoin") and 6.14
(integrity step); E63/E64 in PRD 9; S22 in PRD 12.3.

This replaces a prior implementation that used an Exhibit-invented `.ots` byte layout and an assumed
JSON calendar protocol. As of 2026-09-13 it follows the real reference implementation, read directly
from source (no network calls made to any real calendar).

## Sources followed

Fetched from `raw.githubusercontent.com` on 2026-09-13:

- `opentimestamps/python-opentimestamps` `opentimestamps/core/serialize.py` — LEB128 varuint,
  varbytes, magic/eof asserts.
- `opentimestamps/python-opentimestamps` `opentimestamps/core/op.py` — op tags (`sha1`=0x02,
  `ripemd160`=0x03, `sha256`=0x08, `keccak256`=0x67, `append`=0xf0, `prepend`=0xf1, `reverse`=0xf2,
  `hexlify`=0xf3); unary vs. binary (tag+varbytes(arg)) op serialization.
- `opentimestamps/python-opentimestamps` `opentimestamps/core/notary.py` — `TimeAttestation`:
  8-byte tag + varbytes(payload); `PendingAttestation` (tag `83dfe30d2ef90c8e`, payload =
  varbytes(uri)); `BitcoinBlockHeaderAttestation` (tag `0588960d73d71901`, payload = varuint(height));
  anything else is preserved as an `UnknownAttestation`.
- `opentimestamps/python-opentimestamps` `opentimestamps/core/timestamp.py` — the `Timestamp` tree's
  recursive serialize/deserialize algorithm (branch marker `0xff`, attestation tag `0x00`, "last sibling
  written bare" rule) and `DetachedTimestampFile` (header magic
  `\x00OpenTimestamps\x00\x00Proof\x00\xbf\x89\xe2\xe8\x84\xe8\x92\x94`, uint8 major version, file hash
  op, raw fixed-length digest, then the root `Timestamp`).
- `opentimestamps/python-opentimestamps` `opentimestamps/calendar.py` `RemoteCalendar` — the HTTP
  wire protocol: `POST <calendar>/digest` with the raw digest bytes as the body, `Accept:
  application/vnd.opentimestamps.v1`, response is a bare serialized `Timestamp`; `GET
  <calendar>/timestamp/<hex(commitment)>`, same Accept header, 404 means "don't have it (yet)"
  (`CommitmentNotFoundError`), 200 means a bare serialized `Timestamp`.
- `opentimestamps/opentimestamps-client` `otsclient/cmds.py` — confirmed `RemoteCalendar.submit` is
  what the CLI actually calls to stamp a digest (no separate client-only wire format).

Not fetched / not used: `opentimestamps/python-opentimestamps`
`opentimestamps/tests/core/test_timestamp.py` was fetched but contains Python object-construction unit
tests, not portable byte-vector fixtures, so it wasn't used as a source of test bytes (see below).
`opentimestamps-server`'s own docs were not reachable in this environment.

## What's implemented (`src/integrity/ots.ts`)

- The real `DetachedTimestampFile` binary layout: header magic, major version, file-hash op (hardcoded
  to `OpSHA256`, since Exhibit only ever stamps a sha256 digest — constraint 17), the raw 32-byte
  digest, then the `Timestamp` tree.
- The real `Timestamp` tree serialize/deserialize algorithm (branch marker, "last item written bare",
  attestations mixed with op-edges at the same node).
- All 8 reference op tags (`sha1`, `ripemd160`, `sha256`, `keccak256`, `append`, `prepend`, `reverse`,
  `hexlify`) serialize/deserialize correctly, so a real `.ots` file's op tree parses without error.
- `PendingAttestation` and `BitcoinBlockHeaderAttestation`, plus a generic `unknown` attestation variant
  that preserves any other attestation's raw 8-byte tag and payload byte-for-byte through decode →
  merge → re-encode (Litecoin/Ethereum attestations, or any future kind).
- `encodeTimestampProof`/`decodeTimestampProof` for the *bare* `Timestamp` bytes a calendar's
  `/digest` and `/timestamp/<hex>` responses carry (no `DetachedTimestampFile` header).

**Simplification, documented in `ots.ts`'s header comment:** the reference sorts sibling ops/
attestations at each tree node before serializing (Python tuple/attribute ordering); we approximate
that with a byte-lexicographic tag/operand compare. This is enough for `encode(decode(x)) === x` when
`x` is something *we* built (we always encode in our own canonical order), but re-encoding a
third-party `.ots` file whose siblings were ordered differently will not reproduce that file's exact
bytes, only its meaning. We don't currently have a real third-party `.ots` file to test this gap against
— see "Remaining gaps" below.

## What's implemented (`src/integrity/opentimestamps.ts`)

- `stampDigest`: POSTs the raw 32-byte digest (not hex text) to each calendar's `/digest`, with
  `Accept: application/vnd.opentimestamps.v1`. We additionally send `Content-Type:
  application/x-www-form-urlencoded`; the reference `RemoteCalendar.submit` we read doesn't set an
  explicit Content-Type on that request, so this one header is **unconfirmed** against a live server —
  flagged again below.
- `upgrade`: for every still-pending path, computes the commitment (applying that path's ops to the
  file digest) and does `GET <calendar>/timestamp/<hex(commitment)>`; a 404 is treated as "still
  pending" (matching `CommitmentNotFoundError`), never an error. A 200 response is parsed as a bare
  `Timestamp` and merged onto the existing path (ops concatenated, attestation replaced) — this
  correctly handles a calendar returning more than one new attestation branch, not just a single
  Bitcoin one.
- `verifyProof`: recomputes each path's commitment and, for a Bitcoin attestation, compares it against
  the block's merkle root from the supplied `blockHeaders(height)` lookup — **after reversing the
  commitment's byte order**. The reference (`BitcoinBlockHeaderAttestation.verify_against_blockheader`)
  compares directly against `python-bitcoinlib`'s internal (little-endian) `hashMerkleRoot`, while the
  merkle-root hex strings humans and most block-header sources hand around (RPC `getblock`, explorers)
  are in the reversed, big-endian display order — so the reversal is required when the header source
  hands back that conventional hex. This assumption about the caller's `blockHeaders` byte order is
  called out in the `VerifyOptions` doc comment; it is unconfirmed against any real block-header
  service since S22 only exercises the synthetic fixture (see below).
- `applyOp` supports `append`/`prepend`/`reverse`/`hexlify`/`sha1`/`ripemd160`/`sha256` using Node's
  built-in `crypto` (all confirmed available in this Node 24 environment, including `ripemd160`).
  `keccak256` is **not implemented** — python-opentimestamps uses pycryptodome's Keccak, which is *not*
  the same digest as Node's NIST `sha3-256`; rather than silently compute the wrong hash, `applyOp`
  throws a clear error if a keccak256 op is ever encountered. No Exhibit code path produces or needs
  one today (keccak256 is used for Ethereum-attestation trees, which Exhibit doesn't use).

## Test vectors

**Synthetic, clearly labeled.** No real published `.ots` file or real Bitcoin block header was used:
`opentimestamps/tests/core/test_timestamp.py` (fetched) only contains Python unit-test object
construction, not portable byte vectors, and no real example `.ots` file plus its block's merkle root
was reachable to fetch in this environment. `harness/fixtures/integrity.ts` builds synthetic calendar
servers that speak the *real binary protocol* (raw digest body, bare serialized `Timestamp` responses,
404-for-pending) but attest to a fabricated in-memory chain of heights and merkle roots — there is no
real Bitcoin data involved anywhere in this repo. The codec round-trip tests in `test/integrity.test.ts`
build `OtsProof` values by hand and check `decodeOts(encodeOts(x)) === x`, which validates our own
serializer against our own deserializer (self-consistency), not against an external reference decoder.

## Remaining gaps

1. **Never run against a live calendar.** `stampDigest`/`upgrade`'s exact request shape (headers,
   status-code handling, response size limits — the reference client caps calendar responses at 10,000
   bytes) has not been exercised against `a.pool.opentimestamps.org` or any other real server.
2. **`Content-Type` on `POST /digest` is a guess** (see above) — the reference source doesn't pin it
   down.
3. **No real `.ots` file was available to decode**, so byte-for-byte compatibility with a file produced
   by the reference client (or with its non-canonical sibling ordering) is unverified, and the merkle-
   root byte-order assumption in `verifyProof` is unverified against a real block-header source.
4. **`keccak256` is unsupported** for commitment computation (serialize/parse only) — see above.
5. `harness/scenarios/s22.ts`'s check "OpenTimestamps calendars received only 64-hex digests" asserts
   `req.body` is a hex *string* matching `/^[0-9a-f]{64}$/`. That assertion was written against the old,
   invented hex-text protocol; the real protocol sends the raw 32-byte digest as bytes, so this specific
   check now fails (all other S22 checks — tamper detection, pending→confirmed after upgrade, archive
   handling — pass). `s22.ts` is outside this change's file ownership; the fix is a one-line patch:
   change the check to assert `r.body instanceof Uint8Array && r.body.length === 32`. Filed as a patch
   to request in the implementation report, not applied here.
