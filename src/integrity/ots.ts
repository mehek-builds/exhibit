// OpenTimestamps detached-proof codec (PRD 6.6, 6.14).
//
// This follows the reference implementation's consensus-critical wire format, read from source on
// 2026-09-13 (raw.githubusercontent.com):
//   - opentimestamps/python-opentimestamps `opentimestamps/core/serialize.py` (LEB128 varuint, varbytes,
//     magic/eof asserts)
//   - opentimestamps/python-opentimestamps `opentimestamps/core/op.py` (op tags: sha1=0x02,
//     ripemd160=0x03, sha256=0x08, keccak256=0x67, append=0xf0, prepend=0xf1, reverse=0xf2, hexlify=0xf3;
//     UnaryOp = tag only, BinaryOp = tag + varbytes(arg))
//   - opentimestamps/python-opentimestamps `opentimestamps/core/notary.py` (TimeAttestation: 8-byte tag +
//     varbytes(payload); PendingAttestation tag 83dfe30d2ef90c8e payload=varbytes(uri utf8);
//     BitcoinBlockHeaderAttestation tag 0588960d73d71901 payload=varuint(height); anything else is an
//     UnknownAttestation, preserved as raw tag+payload)
//   - opentimestamps/python-opentimestamps `opentimestamps/core/timestamp.py` (`Timestamp.serialize` /
//     `.deserialize`: a node holds zero-or-more attestations and zero-or-more (op -> child Timestamp)
//     edges; all-but-the-last sibling is prefixed `\xff`, an attestation written as a sibling is prefixed
//     `\xff\x00`, the *last* item at a node is written bare (no `\xff`), and a leaf attestation with no
//     sibling ops is written as a bare `\x00` tag; `DetachedTimestampFile`: magic
//     `\x00OpenTimestamps\x00\x00Proof\x00\xbf\x89\xe2\xe8\x84\xe8\x92\x94`, uint8 major version (=1),
//     the file's hash op (a single CryptOp tag byte), the raw (fixed-length, not varbytes) file digest,
//     then the root `Timestamp`).
//
// Exhibit only ever builds proofs whose digest is sha256 (32 bytes) -- constraint 17 also means we never
// even compute anything else -- so `encodeOts`/`decodeOts` hardcode OpSHA256 as the file_hash_op, exactly
// like `ots stamp` does for a plain file today.
//
// Simplification vs. the reference: canonical ordering. The reference sorts sibling ops/attestations at
// each tree node before serializing (`sorted(self.attestations)`, `sorted(self.ops.items())`), using
// Python tuple/attribute comparisons we approximate below with byte-lexicographic tag/operand compares.
// A `.ots` file built by another implementation that orders siblings differently will still decode
// correctly here (order doesn't affect meaning), but re-encoding it will not reproduce that file's exact
// bytes -- only a proof we built ourselves round-trips byte-for-byte, since we always encode in our own
// canonical order. This is the "gap" noted in docs/integrations/OPENTIMESTAMPS.md.
//
// Also not implemented: OpHexlify size limits/MAX_MSG_LENGTH enforcement, the recursion-limit guard
// python-opentimestamps applies while deserializing (we do not bound tree depth), and the Litecoin /
// Ethereum attestation kinds (both fall through to the generic "unknown attestation" preservation path,
// same as an unrecognized future attestation would).

export type OtsOp =
  | { kind: 'append'; operand: Uint8Array }
  | { kind: 'prepend'; operand: Uint8Array }
  | { kind: 'reverse' }
  | { kind: 'hexlify' }
  | { kind: 'sha1' }
  | { kind: 'ripemd160' }
  | { kind: 'sha256' }
  | { kind: 'keccak256' };

export type OtsAttestation =
  | { kind: 'pending'; uri: string }
  | { kind: 'bitcoin'; height: number }
  /** Any attestation tag we don't recognize (e.g. Litecoin, Ethereum, or a future kind). Preserved verbatim so upgrade/re-serialize never drops or corrupts it. */
  | { kind: 'unknown'; tag: Uint8Array; payload: Uint8Array };

export interface OtsPath {
  /** Ops applied in order, starting from the file digest, to reach the value the attestation below commits to. */
  ops: OtsOp[];
  attestation: OtsAttestation;
}

export interface OtsProof {
  /** The stamped file's sha256 digest (32 bytes). */
  digest: Uint8Array;
  /** One root-to-leaf path per attestation in the proof tree (a calendar's pending ack, or a confirmed Bitcoin attestation). Paths sharing a prefix of ops are merged back into one tree node on encode, exactly as `Timestamp.ops` (a dict keyed by op) does. */
  paths: OtsPath[];
}

// DetachedTimestampFile.HEADER_MAGIC, byte for byte from timestamp.py.
const HEADER_MAGIC = Uint8Array.from([
  0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73, 0x00, 0x00, 0x50, 0x72, 0x6f, 0x6f, 0x66, 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94,
]);
const MAJOR_VERSION = 1;

const OP_SHA1 = 0x02;
const OP_RIPEMD160 = 0x03;
const OP_SHA256 = 0x08;
const OP_KECCAK256 = 0x67;
const OP_APPEND = 0xf0;
const OP_PREPEND = 0xf1;
const OP_REVERSE = 0xf2;
const OP_HEXLIFY = 0xf3;

const ATT_PENDING_TAG = Uint8Array.from([0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e]);
const ATT_BITCOIN_TAG = Uint8Array.from([0x05, 0x88, 0x96, 0x0d, 0x73, 0xd7, 0x19, 0x01]);

const NODE_BRANCH = 0xff;
const NODE_ATTESTATION = 0x00;

class ByteWriter {
  private chunks: number[] = [];
  u8(b: number): void {
    this.chunks.push(b & 0xff);
  }
  bytes(b: Uint8Array): void {
    for (const x of b) this.chunks.push(x);
  }
  /** Unsigned LEB128, as `StreamSerializationContext.write_varuint`. */
  varint(n: number): void {
    let v = Math.floor(n);
    if (v < 0) throw new Error('varint: negative');
    if (v === 0) {
      this.chunks.push(0);
      return;
    }
    while (v !== 0) {
      let byte = v & 0x7f;
      if (v > 0x7f) byte |= 0x80;
      this.chunks.push(byte);
      if (v <= 0x7f) break;
      v = Math.floor(v / 128);
    }
  }
  varbytes(b: Uint8Array): void {
    this.varint(b.length);
    this.bytes(b);
  }
  finish(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

class ByteReader {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}
  eof(): boolean {
    return this.pos >= this.buf.length;
  }
  u8(): number {
    if (this.pos >= this.buf.length) throw new Error('ots: unexpected end of buffer');
    return this.buf[this.pos++]!;
  }
  bytes(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new Error('ots: unexpected end of buffer');
    const out = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  /** As `StreamDeserializationContext.read_varuint`. */
  varint(): number {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = this.u8();
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return value;
  }
  varbytes(): Uint8Array {
    return this.bytes(this.varint());
  }
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function cmpBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i]! !== b[i]!) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

// ---------------- op serialize/deserialize ----------------

function opTag(op: OtsOp): number {
  switch (op.kind) {
    case 'sha1':
      return OP_SHA1;
    case 'ripemd160':
      return OP_RIPEMD160;
    case 'sha256':
      return OP_SHA256;
    case 'keccak256':
      return OP_KECCAK256;
    case 'append':
      return OP_APPEND;
    case 'prepend':
      return OP_PREPEND;
    case 'reverse':
      return OP_REVERSE;
    case 'hexlify':
      return OP_HEXLIFY;
  }
}

function serializeOp(w: ByteWriter, op: OtsOp): void {
  w.u8(opTag(op));
  if (op.kind === 'append' || op.kind === 'prepend') w.varbytes(op.operand);
}

function deserializeOpFromTag(r: ByteReader, tag: number): OtsOp {
  switch (tag) {
    case OP_SHA1:
      return { kind: 'sha1' };
    case OP_RIPEMD160:
      return { kind: 'ripemd160' };
    case OP_SHA256:
      return { kind: 'sha256' };
    case OP_KECCAK256:
      return { kind: 'keccak256' };
    case OP_APPEND:
      return { kind: 'append', operand: r.varbytes() };
    case OP_PREPEND:
      return { kind: 'prepend', operand: r.varbytes() };
    case OP_REVERSE:
      return { kind: 'reverse' };
    case OP_HEXLIFY:
      return { kind: 'hexlify' };
    default:
      throw new Error(`ots: unknown op tag 0x${tag.toString(16)}`);
  }
}

function opEquals(a: OtsOp, b: OtsOp): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'append' || a.kind === 'prepend') return eq(a.operand, (b as typeof a).operand);
  return true;
}

/** Canonical sibling order: by tag byte, then (append/prepend only) by operand bytes -- our approximation of the reference's `Op.__lt__`. */
function cmpOp(a: OtsOp, b: OtsOp): number {
  const ta = opTag(a);
  const tb = opTag(b);
  if (ta !== tb) return ta - tb;
  if ((a.kind === 'append' || a.kind === 'prepend') && (b.kind === 'append' || b.kind === 'prepend')) {
    return cmpBytes(a.operand, b.operand);
  }
  return 0;
}

// ---------------- attestation serialize/deserialize ----------------

function serializeAttestationPayload(w: ByteWriter, att: OtsAttestation): void {
  if (att.kind === 'pending') w.varbytes(new TextEncoder().encode(att.uri));
  else if (att.kind === 'bitcoin') w.varint(att.height);
  else w.bytes(att.payload); // unknown: raw payload, no length header (matches `_serialize_payload`)
}

function attestationTag(att: OtsAttestation): Uint8Array {
  if (att.kind === 'pending') return ATT_PENDING_TAG;
  if (att.kind === 'bitcoin') return ATT_BITCOIN_TAG;
  return att.tag;
}

/** `TimeAttestation.serialize`: 8-byte tag, then varbytes(payload). */
function serializeAttestation(w: ByteWriter, att: OtsAttestation): void {
  w.bytes(attestationTag(att));
  const payload = new ByteWriter();
  serializeAttestationPayload(payload, att);
  w.varbytes(payload.finish());
}

const MAX_PAYLOAD_SIZE = 8192;

/** `TimeAttestation.deserialize`. */
function deserializeAttestation(r: ByteReader): OtsAttestation {
  const tag = r.bytes(8);
  const payload = r.varbytes();
  if (payload.length > MAX_PAYLOAD_SIZE) throw new Error('ots: attestation payload too large');
  const pr = new ByteReader(payload);
  let att: OtsAttestation;
  if (eq(tag, ATT_PENDING_TAG)) {
    const uriBytes = pr.varbytes();
    att = { kind: 'pending', uri: new TextDecoder().decode(uriBytes) };
  } else if (eq(tag, ATT_BITCOIN_TAG)) {
    att = { kind: 'bitcoin', height: pr.varint() };
  } else {
    att = { kind: 'unknown', tag, payload };
    return att; // no further eof check possible: we don't know this payload's grammar
  }
  if (!pr.eof()) throw new Error('ots: trailing bytes in attestation payload');
  return att;
}

function cmpAttestation(a: OtsAttestation, b: OtsAttestation): number {
  const byTag = cmpBytes(attestationTag(a), attestationTag(b));
  if (byTag !== 0) return byTag;
  if (a.kind === 'pending' && b.kind === 'pending') return a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0;
  if (a.kind === 'bitcoin' && b.kind === 'bitcoin') return a.height - b.height;
  if (a.kind === 'unknown' && b.kind === 'unknown') return cmpBytes(a.payload, b.payload);
  return 0;
}

// ---------------- Timestamp tree ----------------

interface TsNode {
  attestations: OtsAttestation[];
  children: { op: OtsOp; node: TsNode }[];
}

function emptyNode(): TsNode {
  return { attestations: [], children: [] };
}

/** Mirrors `Timestamp.serialize`. */
function serializeNode(w: ByteWriter, node: TsNode): void {
  if (node.attestations.length === 0 && node.children.length === 0) throw new Error('ots: empty timestamp node');
  const atts = [...node.attestations].sort(cmpAttestation);
  const ops = [...node.children].sort((a, b) => cmpOp(a.op, b.op));

  if (atts.length > 1) {
    for (const a of atts.slice(0, -1)) {
      w.u8(NODE_BRANCH);
      w.u8(NODE_ATTESTATION);
      serializeAttestation(w, a);
    }
  }
  if (ops.length === 0) {
    w.u8(NODE_ATTESTATION);
    serializeAttestation(w, atts[atts.length - 1]!);
  } else {
    if (atts.length > 0) {
      w.u8(NODE_BRANCH);
      w.u8(NODE_ATTESTATION);
      serializeAttestation(w, atts[atts.length - 1]!);
    }
    for (const { op, node: child } of ops.slice(0, -1)) {
      w.u8(NODE_BRANCH);
      serializeOp(w, op);
      serializeNode(w, child);
    }
    const last = ops[ops.length - 1]!;
    serializeOp(w, last.op);
    serializeNode(w, last.node);
  }
}

/** Mirrors `Timestamp.deserialize`; `applyOp` computes the child node's message so ops nested under it (irrelevant here since we don't validate message length limits) could in principle be checked. */
function deserializeNode(r: ByteReader, depth: number): TsNode {
  if (depth <= 0) throw new Error('ots: timestamp nested too deeply');
  const node = emptyNode();
  const step = (tag: number): void => {
    if (tag === NODE_ATTESTATION) {
      node.attestations.push(deserializeAttestation(r));
    } else {
      const op = deserializeOpFromTag(r, tag);
      const child = deserializeNode(r, depth - 1);
      node.children.push({ op, node: child });
    }
  };
  let tag = r.u8();
  while (tag === NODE_BRANCH) {
    step(r.u8());
    tag = r.u8();
  }
  step(tag);
  return node;
}

function buildTree(paths: OtsPath[]): TsNode {
  const root = emptyNode();
  for (const path of paths) {
    let node = root;
    for (const op of path.ops) {
      let edge = node.children.find((c) => opEquals(c.op, op));
      if (!edge) {
        edge = { op, node: emptyNode() };
        node.children.push(edge);
      }
      node = edge.node;
    }
    node.attestations.push(path.attestation);
  }
  return root;
}

function flattenTree(node: TsNode, prefix: OtsOp[], out: OtsPath[]): void {
  for (const att of node.attestations) out.push({ ops: prefix, attestation: att });
  for (const { op, node: child } of node.children) flattenTree(child, [...prefix, op], out);
}

// ---------------- DetachedTimestampFile ----------------

export function encodeOts(proof: OtsProof): Uint8Array {
  if (proof.digest.length !== 32) throw new Error(`ots: expected a 32-byte sha256 digest, got ${proof.digest.length} bytes`);
  const w = new ByteWriter();
  w.bytes(HEADER_MAGIC);
  w.u8(MAJOR_VERSION);
  w.u8(OP_SHA256); // file_hash_op: Exhibit only ever stamps a sha256 digest
  w.bytes(proof.digest); // fixed-length, not varbytes (matches `ctx.write_bytes(self.timestamp.msg)`)
  const root = buildTree(proof.paths);
  serializeNode(w, root);
  return w.finish();
}

/**
 * Encodes a bare serialized `Timestamp` (no `DetachedTimestampFile` header, no digest) -- what a
 * calendar's `POST /digest` and `GET /timestamp/<commitment>` responses are, per `calendar.py`
 * `RemoteCalendar.submit`/`get_timestamp` (`Timestamp.deserialize(ctx, digest_or_commitment)`).
 */
export function encodeTimestampProof(paths: OtsPath[]): Uint8Array {
  const w = new ByteWriter();
  serializeNode(w, buildTree(paths));
  return w.finish();
}

/** Decodes a bare serialized `Timestamp` (see `encodeTimestampProof`) into root-to-leaf paths. */
export function decodeTimestampProof(bytes: Uint8Array): OtsPath[] {
  const r = new ByteReader(bytes);
  const root = deserializeNode(r, 256);
  if (!r.eof()) throw new Error('ots: trailing bytes after decoding timestamp');
  const paths: OtsPath[] = [];
  flattenTree(root, [], paths);
  return paths;
}

export function decodeOts(bytes: Uint8Array): OtsProof {
  const r = new ByteReader(bytes);
  const magic = r.bytes(HEADER_MAGIC.length);
  if (!eq(magic, HEADER_MAGIC)) throw new Error('ots: bad magic (not an OpenTimestamps proof)');
  const major = r.u8();
  if (major !== MAJOR_VERSION) throw new Error(`ots: unsupported major version ${major}`);
  const fileHashOpTag = r.u8();
  if (fileHashOpTag !== OP_SHA256) throw new Error(`ots: unsupported file hash op tag 0x${fileHashOpTag.toString(16)} (Exhibit only stamps sha256 digests)`);
  const digest = r.bytes(32);
  const root = deserializeNode(r, 256);
  if (!r.eof()) throw new Error('ots: trailing bytes after decode');
  const paths: OtsPath[] = [];
  flattenTree(root, [], paths);
  return { digest, paths };
}
