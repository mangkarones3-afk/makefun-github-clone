// The git object model, implemented from scratch on Node's standard library: SHA-1 object
// ids, commit/tree/tag parsing and building, loose-object storage, packfile read (with
// OFS/REF delta resolution) and write, the pkt-line codec, and the reachability walks the
// smart-HTTP protocol handlers are built on. Objects are stored verbatim — bytes a client
// pushed are the bytes a clone gets back.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

/** oid -> object. One store per repository. */
export type ObjectStore = Map<string, GitObject>;

export const ZERO_OID = '0'.repeat(40);
const HEX40 = /^[0-9a-f]{40}$/;

export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${body.length}\0`, 'utf8'));
  hash.update(body);
  return hash.digest('hex');
}

/** Store an object (idempotent) and answer its id. */
export function putObject(store: ObjectStore, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!store.has(oid)) store.set(oid, { type, data });
  return oid;
}

// ------------------------------------------------------------------ object parsing

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) return entries;
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > buffer.length) return entries;
    entries.push({
      mode: buffer.subarray(offset, space).toString('ascii'),
      name: buffer.subarray(space + 1, nul).toString('utf8'),
      oid: buffer.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: ReadonlyArray<TreeEntry>): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly message: string;
}

export function parseCommit(data: Uint8Array): CommitView | null {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  let tree = '';
  const parents: string[] = [];
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  if (!isObjectId(tree)) return null;
  return { tree, parents, message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8') };
}

export interface TagView {
  readonly object: string;
  readonly type: string;
  readonly tag: string;
}

export function parseTag(data: Uint8Array): TagView | null {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  let object = '';
  let type = '';
  let tag = '';
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  if (!isObjectId(object)) return null;
  return { object, type, tag };
}

export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  author: string;
  committer: string;
  timestamp: number;
  message: string;
}): Buffer {
  const who = `${fields.author} ${fields.timestamp} +0000`;
  const committer = `${fields.committer} ${fields.timestamp} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

// ------------------------------------------------------------------ reachability

/** Peel a tag chain to the object it ultimately names (the object itself when not a tag). */
export function peelToCommit(store: ObjectStore, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = store.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    const tag = parseTag(object.data);
    if (!tag) return null;
    current = tag.object;
  }
  return null;
}

/**
 * The full closure of `roots`. A commit in `cut` is included but its parents are not
 * followed (a shallow boundary the peer already holds the shallow side of).
 */
export function collectClosure(store: ObjectStore, roots: Iterable<string>, cut?: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root) && store.has(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      if (!commit) continue;
      queue.push(commit.tree);
      if (!cut || !cut.has(oid)) for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      const tag = parseTag(object.data);
      if (tag) queue.push(tag.object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

export interface FetchSelection {
  /** Objects to put in the pack. */
  readonly objects: Set<string>;
  /** Commits that become the peer's shallow boundary. */
  readonly shallow: string[];
  /** Client shallow commits whose parents are now included. */
  readonly unshallow: string[];
}

/**
 * What a fetch sends: the closure of `wants` (depth-limited when `depth` is set), minus the
 * closure of `haves` computed with the client's shallow boundary cut off. Mirrors git's
 * upload-pack semantics closely enough for shallow, deepen and incremental fetches.
 */
export function selectFetchObjects(
  store: ObjectStore,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number | undefined,
): FetchSelection {
  const cut = new Set(clientShallow);
  const excluded = collectClosure(store, haves, cut);
  for (const boundary of clientShallow) {
    // A shallow commit the client names is itself excluded only when listed as a have too;
    // git treats `shallow` lines as history cuts, and the exclusion closure above already
    // covers the commit when it is also a have. Nothing extra to do here.
    void boundary;
  }

  const included = new Set<string>();
  const shallowOut = new Set<string>();
  const includeObject = (oid: string): void => {
    // Include a non-commit object and (for trees) everything under it.
    const stack = [oid];
    while (stack.length) {
      const current = stack.pop()!;
      if (included.has(current)) continue;
      const object = store.get(current);
      if (!object) continue;
      if (object.type === 'commit') continue; // commits are included by the BFS below
      included.add(current);
      if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) if (entry.mode !== '160000') stack.push(entry.oid);
      } else if (object.type === 'tag') {
        const tag = parseTag(object.data);
        if (tag) stack.push(tag.object);
      }
    }
  };

  // Resolve wants to commit roots, including any tag objects themselves.
  const roots: string[] = [];
  for (const want of wants) {
    const object = store.get(want);
    if (!object) continue;
    if (object.type === 'tag') {
      included.add(want);
      includeObject(want);
      const commit = peelToCommit(store, want);
      if (commit) roots.push(commit);
    } else if (object.type === 'commit') {
      roots.push(want);
    } else {
      included.add(want);
    }
  }

  // Breadth-first walk over commits by generation distance from the wants.
  const distance = new Map<string, number>();
  const queue: string[] = [];
  for (const root of roots) {
    if (!distance.has(root)) {
      distance.set(root, 0);
      queue.push(root);
    }
  }
  while (queue.length) {
    const oid = queue.shift()!;
    const dist = distance.get(oid)!;
    if (depth !== undefined && dist >= depth) continue;
    const object = store.get(oid);
    if (!object || object.type !== 'commit') continue;
    included.add(oid);
    const commit = parseCommit(object.data);
    if (!commit) continue;
    includeObject(commit.tree);
    const atBoundary = depth !== undefined && dist === depth - 1;
    if (atBoundary) {
      if (commit.parents.some((parent) => store.has(parent))) shallowOut.add(oid);
      continue;
    }
    for (const parent of commit.parents) {
      if (!distance.has(parent) && store.has(parent)) {
        distance.set(parent, dist + 1);
        queue.push(parent);
      }
    }
  }

  // Client shallow commits whose parent is now included stop being shallow.
  const unshallow: string[] = [];
  for (const boundary of clientShallow) {
    if (!included.has(boundary)) continue;
    const object = store.get(boundary);
    if (!object || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    if (commit && commit.parents.some((parent) => included.has(parent))) unshallow.push(boundary);
  }

  for (const oid of excluded) included.delete(oid);
  return { objects: included, shallow: [...shallowOut], unshallow };
}

/** True when `ancestor` is reachable from `descendant` by following commit parents. */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (!object || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    if (!commit) continue;
    for (const parent of commit.parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** The best common ancestor of two commits (nearest shared ancestor by BFS depth), or null. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsOf = (tip: string): Map<string, number> => {
    const depth = new Map<string, number>();
    const queue: Array<[string, number]> = [[tip, 0]];
    while (queue.length) {
      const [oid, dist] = queue.shift()!;
      if (depth.has(oid)) continue;
      const object = store.get(oid);
      if (!object || object.type !== 'commit') continue;
      depth.set(oid, dist);
      const commit = parseCommit(object.data);
      if (commit) for (const parent of commit.parents) queue.push([parent, dist + 1]);
    }
    return depth;
  };
  const fromA = ancestorsOf(a);
  const fromB = ancestorsOf(b);
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [oid, distA] of fromA) {
    const distB = fromB.get(oid);
    if (distB === undefined) continue;
    const score = distA + distB;
    if (score < bestScore) {
      bestScore = score;
      best = oid;
    }
  }
  return best;
}

// ------------------------------------------------------------------ pkt-line

export const PKT_LINE_MAX = 65520;

export function encodePktLine(payload: string | Uint8Array): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  if (data.length > PKT_LINE_MAX - 4) throw new Error('pkt-line too long');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export type PktPacket =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

const HEX4 = /^[0-9a-fA-F]{4}$/;

/**
 * Decode a complete pkt-line stream. Returns the packets and the raw bytes after the
 * terminating flush (a receive-pack packfile), or null when the stream is malformed.
 */
export function decodePktStream(bytes: Buffer): { packets: PktPacket[]; rest: Buffer } | null {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) return null;
    const header = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(header)) return null;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      return { packets, rest: bytes.subarray(offset) };
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3 || length > PKT_LINE_MAX || offset + length > bytes.length) return null;
    packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: Buffer.alloc(0) };
}

/** Data payloads of a packet list, as text lines (trailing newline stripped). */
export function packetLines(packets: readonly PktPacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

// ------------------------------------------------------------------ packfiles

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/**
 * Deflated object bodies by object id. Objects are immutable and content-addressed, so a
 * deflated body stays valid forever; the cache is bounded and evicts oldest-first.
 */
const deflateCache = new Map<string, Buffer>();
const DEFLATE_CACHE_MAX = 100_000;

function deflateObject(oid: string | undefined, type: GitObjectType, data: Buffer): Buffer {
  const key = oid ?? hashObject(type, data);
  const cached = deflateCache.get(key);
  if (cached) return cached;
  const deflated = deflateSync(data);
  if (deflateCache.size >= DEFLATE_CACHE_MAX) {
    const oldest = deflateCache.keys().next().value;
    if (oldest !== undefined) deflateCache.delete(oldest);
  }
  deflateCache.set(key, deflated);
  return deflated;
}

/** Build a packfile of plain (non-delta) objects, in the order given. */
export function writePack(objects: ReadonlyArray<{ oid?: string; type: GitObjectType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateObject(object.oid, object.type, object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } | null {
  if (start >= buffer.length) return null;
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) return null;
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) return null;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } | null {
  if (start >= buffer.length) return null;
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) return null;
    byte = buffer[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } | null {
  try {
    const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (!result.engine.bytesWritten || result.engine.bytesWritten <= 0) return null;
    return { data: result.buffer, next: offset + result.engine.bytesWritten };
  } catch {
    return null;
  }
}

/** Apply a git delta instruction stream to a base object's bytes; null when corrupt. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer | null {
  const baseBuffer = Buffer.isBuffer(base) ? base : Buffer.from(base);
  const deltaBuffer = Buffer.isBuffer(delta) ? delta : Buffer.from(delta);
  let offset = 0;
  const readSize = (): number | null => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= deltaBuffer.length) return null;
      const byte = deltaBuffer[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) return null;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize === null || targetSize === null || sourceSize !== baseBuffer.length) return null;
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) return null;
          copyOffset += deltaBuffer[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) return null;
          copySize += deltaBuffer[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > baseBuffer.length || written + copySize > targetSize) return null;
      baseBuffer.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > deltaBuffer.length || written + literal > targetSize) return null;
      deltaBuffer.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      return null;
    }
  }
  return written === targetSize ? out : null;
}

export interface PackReadOutcome {
  readonly objects: Array<{ oid: string; type: GitObjectType; data: Buffer }>;
}

/**
 * Read a packfile and resolve every object, including deltas. A REF_DELTA base the pack
 * itself lacks is taken from `resolveBase` (a thin pack against the store). Returns null
 * on any corruption, including a trailer checksum mismatch.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackReadOutcome | null {
  if (pack.length < 32) return null;
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') return null;
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) return null;
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (pack.subarray(trailerStart).toString('hex') !== computed) return null;

  interface RawEntry {
    offset: number;
    typeCode: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    if (!header) return null;
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      if (!base || base.baseOffset <= 0 || base.baseOffset > entryOffset) return null;
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) return null;
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      return null;
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (!inflated || inflated.data.length !== header.size) return null;
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) return null;

  const resolvedByOid = new Map<string, RawEntry & { resolvedType?: GitObjectType; resolvedData?: Buffer; oid?: string }>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } | null => {
    const cached = entry as RawEntry & { resolvedType?: GitObjectType; resolvedData?: Buffer; oid?: string };
    if (cached.resolvedData && cached.resolvedType && cached.oid) {
      return { type: cached.resolvedType, data: cached.resolvedData, oid: cached.oid };
    }
    if (resolving.has(entry.offset)) return null;
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) return null;
      const base = resolve(baseEntry);
      if (!base) return null;
      const applied = applyDelta(base.data, entry.data);
      if (!applied) return null;
      type = base.type;
      data = applied;
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      let base: { type: GitObjectType; data: Buffer } | null = null;
      if (baseEntry) {
        const resolved = resolve(baseEntry);
        if (resolved) base = resolved;
      }
      if (!base) {
        const external = resolveBase?.(wanted);
        if (!external) return null;
        base = external;
      }
      const applied = applyDelta(base.data, entry.data);
      if (!applied) return null;
      type = base.type;
      data = applied;
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    cached.resolvedType = type;
    cached.resolvedData = data;
    cached.oid = oid;
    resolvedByOid.set(oid, cached);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  const objects: Array<{ oid: string; type: GitObjectType; data: Buffer }> = [];
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!resolved) return null;
    objects.push(resolved);
  }
  return { objects };
}
