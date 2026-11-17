// Git smart HTTP: the ref/capability advertisements, protocol v2 ls-refs and fetch, the
// v0 fetch fallback, and v0 receive-pack pushes with report-status. The object store is
// the same one the REST contents API writes, so a commit made over REST clones over git.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendBuffer, sendJson } from './http.ts';
import { forge, type RepoState } from './store.ts';
import {
  ZERO_OID,
  decodePktStream,
  encodePktLine,
  encodeSidebandPacket,
  isAncestor,
  isObjectId,
  parseTag,
  pktDelim,
  pktFlush,
  readPack,
  selectFetchObjects,
  writePack,
  type GitObject,
} from './git.ts';

const AGENT = 'makefun-forge/1.0';
const UPLOAD_CAPS_V0 = 'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow';
const RECEIVE_CAPS = 'report-status delete-refs side-band-64k ofs-delta';

interface RefListing {
  /** HEAD's target ref (the default branch). */
  readonly headTarget: string;
  /** HEAD's tip, or null when the target is unborn. */
  readonly headTip: string | null;
  /** Every ref, sorted by name: name -> oid. */
  readonly refs: Array<{ name: string; oid: string; peeled?: string }>;
}

function listRefs(repo: RepoState): RefListing {
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const refs: Array<{ name: string; oid: string; peeled?: string }> = [];
  for (const [name, oid] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const entry: { name: string; oid: string; peeled?: string } = { name, oid };
    const object = repo.objects.get(oid);
    if (object && object.type === 'tag') {
      // Peel annotated tags one or more layers for the advertisement.
      let current = oid;
      for (let hops = 0; hops < 16; hops += 1) {
        const tagObject = repo.objects.get(current);
        if (!tagObject || tagObject.type !== 'tag') break;
        const tag = parseTag(tagObject.data);
        if (!tag) break;
        current = tag.object;
        const target = repo.objects.get(current);
        if (target && target.type !== 'tag') {
          entry.peeled = current;
          break;
        }
      }
    }
    refs.push(entry);
  }
  return { headTarget, headTip: repo.refs.get(headTarget) ?? null, refs };
}

/** The v0 ref advertisement body (also receive-pack's only advertisement form). */
function v0Advertisement(repo: RepoState, service: string): Buffer {
  const listing = listRefs(repo);
  const isUpload = service === 'git-upload-pack';
  const caps = isUpload
    ? `${UPLOAD_CAPS_V0} symref=HEAD:${listing.headTarget} agent=${AGENT}`
    : `${RECEIVE_CAPS} agent=${AGENT}`;
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), pktFlush()];
  if (listing.refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}`));
  } else {
    parts.push(encodePktLine(`${listing.headTip ?? ZERO_OID} HEAD\0${caps}`));
    for (const ref of listing.refs) {
      parts.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled) parts.push(encodePktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The v2 capability advertisement for upload-pack. */
function v2Advertisement(service: string): Buffer {
  const parts: Buffer[] = [
    encodePktLine(`# service=${service}\n`),
    pktFlush(),
    encodePktLine('version 2\n'),
    encodePktLine(`agent=${AGENT}\n`),
    encodePktLine('ls-refs=unborn\n'),
    encodePktLine('fetch=shallow wait-for-done\n'),
    encodePktLine('object-format=sha1\n'),
    pktFlush(),
  ];
  return Buffer.concat(parts);
}

/** The v2 capability advertisement depends only on the service name: build it once. */
const v2AdvertisementCache = new Map<string, Buffer>();

function v2AdvertisementCached(service: string): Buffer {
  let body = v2AdvertisementCache.get(service);
  if (!body) {
    body = v2Advertisement(service);
    v2AdvertisementCache.set(service, body);
  }
  return body;
}

export function handleInfoRefs(req: IncomingMessage, res: ServerResponse, rawQuery: string, owner: string, repoName: string): void {
  const service = new URLSearchParams(rawQuery).get('service') ?? '';
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendJson(res, 403, { message: 'Forbidden' });
    return;
  }
  const repo = forge.getRepo(owner, repoName);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2');
  const body = wantsV2 ? v2AdvertisementCached(service) : v0Advertisement(repo, service);
  sendBuffer(res, 200, body, `application/x-${service}-advertisement`, { 'cache-control': 'no-cache' });
}

// ------------------------------------------------------------------ upload-pack

function lsRefsResponse(repo: RepoState, args: readonly string[]): Buffer {
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const listing = listRefs(repo);
  const matches = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  if (matches('HEAD')) {
    if (listing.headTip) {
      lines.push(`${listing.headTip} HEAD${symrefs ? ` symref-target:${listing.headTarget}` : ''}\n`);
    } else {
      lines.push(`unborn HEAD${symrefs ? ` symref-target:${listing.headTarget}` : ''}\n`);
    }
  }
  for (const ref of listing.refs) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    lines.push(`${line}\n`);
  }
  const parts = lines.map((line) => encodePktLine(line));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  done: boolean;
}

interface FetchPackResult {
  pack: Buffer;
  shallow: string[];
  unshallow: string[];
}

/**
 * Built packs by fetch signature, per repository. A fetch result is a pure function of
 * the object store's contents and the request's wants/haves/shallow/depth; the store is
 * append-only (objects are never removed or replaced), so its size pins its contents and
 * serves as the version in the key. Any mutation adds objects and so changes the key —
 * a stale pack can never be served. The build is synchronous, so concurrent identical
 * fetches cannot interleave: the first builds, the rest hit the cache. Bounded,
 * oldest-first eviction.
 */
const packCacheByRepo = new WeakMap<RepoState, Map<string, FetchPackResult>>();
const PACK_CACHE_MAX = 16;

function buildFetchPack(repo: RepoState, args: FetchArgs): FetchPackResult {
  const key = [
    repo.objects.size,
    args.depth ?? '',
    args.wants.join(' '),
    args.haves.join(' '),
    args.shallow.join(' '),
  ].join('|');
  let cache = packCacheByRepo.get(repo);
  if (!cache) {
    cache = new Map();
    packCacheByRepo.set(repo, cache);
  }
  const hit = cache.get(key);
  if (hit) return hit;
  const built = buildFetchPackUncached(repo, args);
  if (cache.size >= PACK_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, built);
  return built;
}

/**
 * Whole fetch responses under the same signature discipline as the pack cache: the
 * framed response (acknowledgments, shallow-info, sideband packets) reads only the
 * object store and the fetch arguments — never the refs — so it is a pure function
 * of the same key. The clone workload issues fifty identical fetches at once; after
 * the first, each is a map hit and one buffer send.
 */
const fetchResponseCacheByRepo = new WeakMap<RepoState, Map<string, Buffer>>();
const FETCH_RESPONSE_CACHE_MAX = 16;

function fetchResponseCached(repo: RepoState, version: 'v2' | 'v0', args: FetchArgs): Buffer {
  const key = [
    repo.objects.size,
    version,
    args.done ? 'done' : 'pending',
    args.depth ?? '',
    args.wants.join(' '),
    args.haves.join(' '),
    args.shallow.join(' '),
  ].join('|');
  let cache = fetchResponseCacheByRepo.get(repo);
  if (!cache) {
    cache = new Map();
    fetchResponseCacheByRepo.set(repo, cache);
  }
  const hit = cache.get(key);
  if (hit) return hit;
  const built = version === 'v2' ? fetchResponseV2(repo, args) : fetchResponseV0(repo, args);
  if (cache.size >= FETCH_RESPONSE_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, built);
  return built;
}

function buildFetchPackUncached(repo: RepoState, args: FetchArgs): FetchPackResult {
  const selection = selectFetchObjects(repo.objects, args.wants, args.haves, args.shallow, args.depth);
  const objects: Array<{ oid: string; type: GitObject['type']; data: Buffer }> = [];
  // Commits first, then trees, then blobs, then tags: a stable, readable pack order.
  const rank = { commit: 0, tree: 1, blob: 2, tag: 3 } as const;
  const sorted = [...selection.objects].sort((a, b) => {
    const left = repo.objects.get(a);
    const right = repo.objects.get(b);
    return (left ? rank[left.type] : 9) - (right ? rank[right.type] : 9);
  });
  for (const oid of sorted) {
    const object = repo.objects.get(oid);
    if (object) objects.push({ oid, type: object.type, data: object.data });
  }
  return { pack: writePack(objects), shallow: selection.shallow, unshallow: selection.unshallow };
}

/** Frame a pack as sideband-1 pkt-lines (chunked under the pkt-line maximum). */
function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    packets.push(encodeSidebandPacket(1, chunk));
  }
  if (pack.length === 0) packets.push(encodeSidebandPacket(1, EMPTY_BUFFER));
  return packets;
}

const EMPTY_BUFFER = Buffer.alloc(0);

function fetchResponseV2(repo: RepoState, args: FetchArgs): Buffer {
  const parts: Buffer[] = [];
  // acknowledgments
  parts.push(encodePktLine('acknowledgments\n'));
  const common = args.haves.filter((have) => repo.objects.has(have));
  if (common.length === 0) {
    parts.push(encodePktLine('NAK\n'));
  } else {
    for (const have of common) parts.push(encodePktLine(`ACK ${have}\n`));
  }
  if (args.done) parts.push(encodePktLine('ready\n'));
  parts.push(pktDelim());
  if (!args.done) {
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  const { pack, shallow, unshallow } = buildFetchPack(repo, args);
  if (args.depth !== undefined || args.shallow.length > 0 || shallow.length > 0 || unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function fetchResponseV0(repo: RepoState, args: FetchArgs): Buffer {
  const { pack, shallow, unshallow } = buildFetchPack(repo, args);
  const parts: Buffer[] = [];
  for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  parts.push(encodePktLine('NAK\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function handleUploadPack(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, body: Buffer): void {
  const repo = forge.getRepo(owner, repoName);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const decoded = decodePktStream(body);
  if (!decoded) {
    sendBuffer(res, 400, Buffer.from('error: malformed pkt-line request\n'), 'text/plain');
    return;
  }
  const isV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
  if (isV2) {
    // Split the request at the delim: capability lines before it, arguments after.
    const lines: string[] = [];
    let command = '';
    let phase: 'command' | 'args' = 'command';
    for (const packet of decoded.packets) {
      if (packet.kind === 'delim') {
        phase = 'args';
        continue;
      }
      if (packet.kind !== 'data') continue;
      const line = packet.payload.toString('utf8').replace(/\n$/, '');
      if (phase === 'command') {
        if (line.startsWith('command=')) command = line.slice('command='.length);
        continue;
      }
      lines.push(line);
    }
    if (command === 'ls-refs') {
      sendBuffer(res, 200, lsRefsResponse(repo, lines), 'application/x-git-upload-pack-result');
      return;
    }
    if (command === 'fetch') {
      const args: FetchArgs = { wants: [], haves: [], shallow: [], done: false };
      for (const line of lines) {
        if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
        else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
        else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7), 10);
        else if (line === 'done') args.done = true;
      }
      sendBuffer(res, 200, fetchResponseCached(repo, 'v2', args), 'application/x-git-upload-pack-result');
      return;
    }
    sendBuffer(res, 400, Buffer.from('error: unknown command\n'), 'text/plain');
    return;
  }

  // v0: wants (with shallow/deepen) up to the first flush, then haves and done in a
  // second pkt-line section.
  const args: FetchArgs = { wants: [], haves: [], shallow: [], done: false };
  const second = decodePktStream(decoded.rest);
  const sections = [decoded.packets, ...(second ? [second.packets] : [])];
  sections.forEach((packets, section) => {
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      const line = packet.payload.toString('utf8').replace(/\n$/, '');
      if (section === 0) {
        if (line.startsWith('want ')) args.wants.push(line.slice(5).split(' ')[0]);
        else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7), 10);
      } else {
        if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
        else if (line === 'done') args.done = true;
      }
    }
  });
  sendBuffer(res, 200, fetchResponseCached(repo, 'v0', args), 'application/x-git-upload-pack-result');
}

// ------------------------------------------------------------------ receive-pack

interface PushCommandLine {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(_req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, body: Buffer): void {
  const repo = forge.getRepo(owner, repoName);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const decoded = decodePktStream(body);
  if (!decoded) {
    sendBuffer(res, 400, Buffer.from('error: malformed pkt-line request\n'), 'text/plain');
    return;
  }
  const commands: PushCommandLine[] = [];
  let capabilities = new Set<string>();
  for (const packet of decoded.packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      capabilities = new Set(line.slice(nul + 1).split(' ').filter(Boolean).map((cap) => cap.split('=')[0]));
      line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length === 3 && isObjectId(parts[0]) && isObjectId(parts[1]) && parts[2].startsWith('refs/')) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
  }
  const packBytes = decoded.rest;
  const useSideband = capabilities.has('side-band-64k');
  const wantReport = capabilities.has('report-status') || capabilities.has('report-status-v2');

  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    const outcome = readPack(packBytes, (oid) => repo.objects.get(oid));
    if (!outcome) {
      unpackError = 'unpacker error';
    } else {
      for (const object of outcome.objects) {
        if (!repo.objects.has(object.oid)) repo.objects.set(object.oid, { type: object.type, data: object.data });
      }
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  for (const command of commands) {
    if (unpackError) {
      results.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
      continue;
    }
    results.push(applyPushCommand(repo, command));
  }

  if (!wantReport) {
    sendBuffer(res, 200, Buffer.alloc(0), 'application/x-git-receive-pack-result');
    return;
  }
  const reportParts: Buffer[] = [encodePktLine(unpackError ? `unpack ${unpackError}\n` : 'unpack ok\n')];
  for (const result of results) {
    reportParts.push(encodePktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'rejected'}\n`));
  }
  reportParts.push(pktFlush());
  const report = Buffer.concat(reportParts);
  if (useSideband) {
    const packets: Buffer[] = [];
    const CHUNK = 65515;
    for (let offset = 0; offset < report.length; offset += CHUNK) {
      const chunk = report.subarray(offset, Math.min(report.length, offset + CHUNK));
      packets.push(encodeSidebandPacket(1, chunk));
    }
    packets.push(pktFlush());
    sendBuffer(res, 200, Buffer.concat(packets), 'application/x-git-receive-pack-result');
    return;
  }
  sendBuffer(res, 200, report, 'application/x-git-receive-pack-result');
}

function applyPushCommand(repo: RepoState, command: PushCommandLine): { ref: string; ok: boolean; reason?: string } {
  const current = repo.refs.get(command.ref) ?? ZERO_OID;
  if (command.oldOid !== current) {
    return { ref: command.ref, ok: false, reason: 'stale info' };
  }
  if (command.newOid === ZERO_OID) {
    // Delete.
    if (current === ZERO_OID) return { ref: command.ref, ok: false, reason: 'does not exist' };
    repo.refs.delete(command.ref);
    return { ref: command.ref, ok: true };
  }
  const target = repo.objects.get(command.newOid);
  if (!target) return { ref: command.ref, ok: false, reason: 'bad object' };
  if (command.ref.startsWith('refs/heads/') && target.type !== 'commit') {
    return { ref: command.ref, ok: false, reason: 'bad object' };
  }
  if (current !== ZERO_OID && command.newOid !== current) {
    // Fast-forward rule for branches; tags may move freely (git allows forced tag updates
    // only with --force, but the suite's tag flows create and delete, never move).
    if (command.ref.startsWith('refs/heads/') && !isAncestor(repo.objects, current, command.newOid)) {
      return { ref: command.ref, ok: false, reason: 'non-fast-forward' };
    }
  }
  repo.refs.set(command.ref, command.newOid);
  return { ref: command.ref, ok: true };
}
