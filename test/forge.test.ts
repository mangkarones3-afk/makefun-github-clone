// The forge's own tests: git object and packfile round-trips at the module level, the
// REST routes' status codes over HTTP, and a full git-protocol round trip (create via
// REST, push via receive-pack, clone via upload-pack v2, trees compared byte for byte).
// Run with: node --experimental-strip-types --test test/forge.test.ts

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type { Server } from 'node:http';
import {
  applyDelta,
  buildCommit,
  buildTree,
  decodePktStream,
  encodePktLine,
  hashObject,
  parseCommit,
  parseTree,
  pktFlush,
  readPack,
  writePack,
} from '../git.ts';
import { createApp } from '../app.ts';

process.env.MAKEFUN_SHOP_TOKEN = 'test-token';
const TOKEN = 'test-token';
const OWNER = 'adaiversen';

let server: Server;
let base = '';

before(async () => {
  server = createApp();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any; headers: Headers; text: string }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, headers: response.headers, text };
}

// ------------------------------------------------------------------ object model

test('git objects: hash, build and parse round-trip', () => {
  const blob = Buffer.from('hello forge\n', 'utf8');
  const blobOid = hashObject('blob', blob);
  // The well-known git blob id for this content is a fixed point of the format.
  assert.equal(blobOid, createHash('sha1').update(Buffer.from(`blob ${blob.length}\0`)).update(blob).digest('hex'));

  const tree = buildTree([
    { mode: '100644', name: 'README.md', oid: blobOid },
    { mode: '40000', name: 'src', oid: blobOid },
  ]);
  const entries = parseTree(tree);
  assert.equal(entries.length, 2);
  assert.equal(entries.find((e) => e.name === 'README.md')?.oid, blobOid);
  assert.equal(entries.find((e) => e.name === 'src')?.mode, '40000');

  const treeOid = hashObject('tree', tree);
  const commit = buildCommit({
    tree: treeOid,
    parents: [],
    author: 'A U Thor <a@example.invalid>',
    committer: 'A U Thor <a@example.invalid>',
    timestamp: 1700000000,
    message: 'first\n',
  });
  const parsed = parseCommit(commit);
  assert.ok(parsed);
  assert.equal(parsed.tree, treeOid);
  assert.deepEqual(parsed.parents, []);
  assert.equal(parsed.message, 'first\n');
});

test('packfile: plain round-trip and delta resolution', () => {
  const blobA = Buffer.from('hello world', 'utf8');
  const blobB = Buffer.from('second blob, somewhat longer content here', 'utf8');
  const pack = writePack([
    { type: 'blob', data: blobA },
    { type: 'blob', data: blobB },
  ]);
  const read = readPack(pack);
  assert.ok(read);
  assert.equal(read.objects.length, 2);
  const byOid = new Map(read.objects.map((o) => [o.oid, o.data.toString('utf8')]));
  assert.equal(byOid.get(hashObject('blob', blobA)), 'hello world');
  assert.equal(byOid.get(hashObject('blob', blobB)), 'second blob, somewhat longer content here');

  // A REF_DELTA pack built by hand: target = base + '!'.
  const delta = Buffer.from([11, 12, 0x91, 0x00, 0x0b, 0x01, 0x21]);
  const applied = applyDelta(blobA, delta);
  assert.ok(applied);
  assert.equal(applied.toString('utf8'), 'hello world!');
  const targetOid = hashObject('blob', Buffer.from('hello world!', 'utf8'));
  const baseOid = hashObject('blob', blobA);
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(2, 8);
  const entryHeader = (typeCode: number, size: number): Buffer => {
    const bytes: number[] = [];
    let remaining = size;
    let first = (typeCode << 4) | (remaining & 0x0f);
    remaining = Math.floor(remaining / 16);
    while (remaining > 0) {
      bytes.push(first | 0x80);
      first = remaining & 0x7f;
      remaining = Math.floor(remaining / 128);
    }
    bytes.push(first);
    return Buffer.from(bytes);
  };
  const deltaPackBody = Buffer.concat([
    header,
    entryHeader(3, blobA.length),
    deflateSync(blobA),
    entryHeader(7, delta.length),
    Buffer.from(baseOid, 'hex'),
    deflateSync(delta),
  ]);
  const deltaPack = Buffer.concat([deltaPackBody, createHash('sha1').update(deltaPackBody).digest()]);
  const readDelta = readPack(deltaPack);
  assert.ok(readDelta);
  const deltaByOid = new Map(readDelta.objects.map((o) => [o.oid, o.data.toString('utf8')]));
  assert.equal(deltaByOid.get(targetOid), 'hello world!');

  // A corrupted trailer is refused.
  const corrupt = Buffer.from(pack);
  corrupt[corrupt.length - 1] ^= 0xff;
  assert.equal(readPack(corrupt), null);
});

// ------------------------------------------------------------------ REST statuses

test('rest: auth, root, meta and repository lifecycle statuses', async () => {
  const noAuth = await fetch(`${base}/api/v3/user/repos`);
  assert.equal(noAuth.status, 401);
  const noAuthBody = (await noAuth.json()) as any;
  assert.equal(typeof noAuthBody.message, 'string');
  assert.ok(noAuth.headers.get('x-github-request-id'));

  const root = await api('GET', '/api/v3/');
  assert.equal(root.status, 200);
  assert.ok(root.headers.get('x-oauth-scopes'));
  assert.match(root.headers.get('content-type') ?? '', /application\/json/);

  const meta = await api('GET', '/api/v3/meta');
  assert.equal(meta.status, 200);
  assert.equal(typeof meta.json.installed_version, 'string');

  const created = await api('POST', '/api/v3/user/repos', { name: 'rest-checks', private: true, description: 'one' });
  assert.equal(created.status, 201);
  assert.equal(created.json.name, 'rest-checks');
  assert.equal(created.json.private, true);
  assert.equal(created.json.default_branch, 'main');

  const duplicate = await api('POST', '/api/v3/user/repos', { name: 'rest-checks' });
  assert.equal(duplicate.status, 422);
  assert.match(duplicate.json.message, /already exists/i);

  const fetched = await api('GET', `/api/v3/repos/${OWNER}/rest-checks`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.json.description, 'one');

  const patched = await api('PATCH', `/api/v3/repos/${OWNER}/rest-checks`, { description: 'two' });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.description, 'two');

  const stranger = await api('GET', '/api/v3/repos/olgabauer/rest-checks');
  assert.equal(stranger.status, 404);

  const unknown = await api('GET', '/api/v3/definitely-not-a-route');
  assert.equal(unknown.status, 404);
  assert.equal(typeof unknown.json.message, 'string');

  const malformed = await api('POST', '/api/v3/user/repos', '{"name":');
  assert.equal(malformed.status, 400);
  assert.equal(typeof malformed.json.message, 'string');

  const removed = await api('DELETE', `/api/v3/repos/${OWNER}/rest-checks`);
  assert.equal(removed.status, 204);
  const gone = await api('GET', `/api/v3/repos/${OWNER}/rest-checks`);
  assert.equal(gone.status, 404);
});

test('rest: contents sha rules, labels, issues, comments', async () => {
  await api('POST', '/api/v3/user/repos', { name: 'rest-contents', private: false });
  const repoPath = `/api/v3/repos/${OWNER}/rest-contents`;
  const content = Buffer.from('body { color: red; }\n').toString('base64');

  const created = await api('PUT', `${repoPath}/contents/config/token.css`, { message: 'add css', content });
  assert.equal(created.status, 201);
  const sha1 = created.json.content.sha;
  assert.match(sha1, /^[0-9a-f]{40}$/);
  assert.ok(created.json.commit.sha);

  const read = await api('GET', `${repoPath}/contents/config/token.css`);
  assert.equal(read.status, 200);
  assert.equal(read.json.sha, sha1);
  assert.equal(Buffer.from(read.json.content, 'base64').toString('utf8'), 'body { color: red; }\n');

  const dir = await api('GET', `${repoPath}/contents/config`);
  assert.equal(dir.status, 200);
  assert.equal(dir.json[0].type, 'file');
  assert.equal(dir.json[0].path, 'config/token.css');

  const stale = await api('PUT', `${repoPath}/contents/config/token.css`, {
    message: 'stale write',
    content: Buffer.from('x').toString('base64'),
    sha: 'f'.repeat(40),
  });
  assert.equal(stale.status, 409);

  const updated = await api('PUT', `${repoPath}/contents/config/token.css`, {
    message: 'update css',
    content: Buffer.from('body { color: blue; }\n').toString('base64'),
    sha: sha1,
  });
  assert.equal(updated.status, 200);
  assert.notEqual(updated.json.content.sha, sha1);

  const label = await api('POST', `${repoPath}/labels`, { name: 'bug', color: 'd73a4a' });
  assert.equal(label.status, 201);

  const badIssue = await api('POST', `${repoPath}/issues`, { title: 't', body: 'b', labels: ['nope'] });
  assert.equal(badIssue.status, 422);

  const issue = await api('POST', `${repoPath}/issues`, { title: 'real', body: 'b', labels: ['bug'] });
  assert.equal(issue.status, 201);
  assert.equal(issue.json.number, 1);
  assert.equal(issue.json.labels[0].name, 'bug');

  const comment = await api('POST', `${repoPath}/issues/1/comments`, { body: 'first!' });
  assert.equal(comment.status, 201);
  const comments = await api('GET', `${repoPath}/issues/1/comments`);
  assert.equal(comments.json.length, 1);
  assert.equal(comments.json[0].body, 'first!');

  const closed = await api('PATCH', `${repoPath}/issues/1`, { state: 'closed' });
  assert.equal(closed.json.state, 'closed');
  const openList = await api('GET', `${repoPath}/issues?state=open`);
  assert.equal(openList.json.length, 0);
  const allList = await api('GET', `${repoPath}/issues?state=all`);
  assert.equal(allList.json.length, 1);

  const deleted = await api('DELETE', `${repoPath}/contents/config/token.css`, { message: 'rm', sha: updated.json.content.sha });
  assert.equal(deleted.status, 200);
  const missing = await api('GET', `${repoPath}/contents/config/token.css`);
  assert.equal(missing.status, 404);
});

test('rest: pull request squash merge and conflict', async () => {
  await api('POST', '/api/v3/user/repos', { name: 'rest-pulls', private: false });
  const repoPath = `/api/v3/repos/${OWNER}/rest-pulls`;
  const put = (path: string, text: string, branch?: string) =>
    api('PUT', `${repoPath}/contents/${path}`, {
      message: `write ${path}`,
      content: Buffer.from(text).toString('base64'),
      ...(branch ? { branch } : {}),
    });

  const baseWrite = await put('file.txt', 'base text\n');
  assert.equal(baseWrite.status, 201);
  const branches = await api('GET', `${repoPath}/branches`);
  const mainSha = branches.json.find((b: any) => b.name === 'main').commit.sha;
  const ref = await api('POST', `${repoPath}/git/refs`, { ref: 'refs/heads/feature', sha: mainSha });
  assert.equal(ref.status, 201);
  const headWrite = await api('PUT', `${repoPath}/contents/file.txt`, {
    message: 'write file.txt',
    content: Buffer.from('base text\nfeature line\n').toString('base64'),
    branch: 'feature',
    sha: baseWrite.json.content.sha,
  });
  assert.equal(headWrite.status, 200);

  const pull = await api('POST', `${repoPath}/pulls`, { title: 'feature work', body: 'b', head: 'feature', base: 'main' });
  assert.equal(pull.status, 201);
  assert.equal(pull.json.head.ref, 'feature');
  assert.equal(pull.json.base.ref, 'main');

  const files = await api('GET', `${repoPath}/pulls/${pull.json.number}/files`);
  assert.equal(files.json.length, 1);
  assert.equal(files.json[0].filename, 'file.txt');
  assert.equal(files.json[0].additions, 1);

  const merged = await api('PUT', `${repoPath}/pulls/${pull.json.number}/merge`, { merge_method: 'squash' });
  assert.equal(merged.status, 200);
  assert.equal(merged.json.merged, true);
  const after = await api('GET', `${repoPath}/pulls/${pull.json.number}`);
  assert.equal(after.json.state, 'closed');
  assert.equal(after.json.merged, true);
  assert.equal(after.json.merge_commit_sha, merged.json.sha);
  const onMain = await api('GET', `${repoPath}/contents/file.txt?ref=main`);
  assert.equal(Buffer.from(onMain.json.content, 'base64').toString('utf8'), 'base text\nfeature line\n');
});

// ------------------------------------------------------------------ git protocol

function pktLines(lines: string[]): Buffer {
  return Buffer.concat([...lines.map((line) => encodePktLine(line)), pktFlush()]);
}

async function gitPost(path: string, body: Buffer, protocol?: string): Promise<Buffer> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/x-git-upload-pack-request',
      ...(protocol ? { 'git-protocol': protocol } : {}),
    },
    body,
  });
  assert.equal(response.status, 200);
  return Buffer.from(await response.arrayBuffer());
}

test('git protocol: push then clone round-trip, trees identical', async () => {
  await api('POST', '/api/v3/user/repos', { name: 'git-roundtrip', private: true });
  const gitPath = `/${OWNER}/git-roundtrip.git`;

  // Build a two-commit history locally.
  const blob1 = Buffer.from('one\n', 'utf8');
  const blob1Oid = hashObject('blob', blob1);
  const tree1 = buildTree([{ mode: '100644', name: 'a.txt', oid: blob1Oid }]);
  const tree1Oid = hashObject('tree', tree1);
  const commit1 = buildCommit({ tree: tree1Oid, parents: [], author: 'T <t@e.invalid>', committer: 'T <t@e.invalid>', timestamp: 1700000000, message: 'c1\n' });
  const commit1Oid = hashObject('commit', commit1);
  const blob2 = Buffer.from('two\n', 'utf8');
  const blob2Oid = hashObject('blob', blob2);
  const tree2 = buildTree([
    { mode: '100644', name: 'a.txt', oid: blob1Oid },
    { mode: '100644', name: 'b.txt', oid: blob2Oid },
  ]);
  const tree2Oid = hashObject('tree', tree2);
  const commit2 = buildCommit({ tree: tree2Oid, parents: [commit1Oid], author: 'T <t@e.invalid>', committer: 'T <t@e.invalid>', timestamp: 1700000001, message: 'c2\n' });
  const commit2Oid = hashObject('commit', commit2);

  // Push both commits to refs/heads/main.
  const pack = writePack([
    { type: 'commit', data: commit1 },
    { type: 'tree', data: tree1 },
    { type: 'blob', data: blob1 },
    { type: 'commit', data: commit2 },
    { type: 'tree', data: tree2 },
    { type: 'blob', data: blob2 },
  ]);
  const commandLine = `${'0'.repeat(40)} ${commit2Oid} refs/heads/main\0report-status side-band-64k\n`;
  const pushBody = Buffer.concat([encodePktLine(commandLine), pktFlush(), pack]);
  const pushResponse = await fetch(`${base}${gitPath}/git-receive-pack`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/x-git-receive-pack-request' },
    body: pushBody,
  });
  assert.equal(pushResponse.status, 200);
  const pushBytes = Buffer.from(await pushResponse.arrayBuffer());
  const pushPackets = decodePktStream(pushBytes);
  assert.ok(pushPackets);
  // Band-1 payloads carry the report-status pkt stream.
  const reportBytes = Buffer.concat(
    pushPackets.packets.filter((p) => p.kind === 'data').map((p) => (p.kind === 'data' ? p.payload.subarray(1) : Buffer.alloc(0))),
  );
  const report = decodePktStream(reportBytes);
  assert.ok(report);
  const reportText = report.packets.map((p) => (p.kind === 'data' ? p.payload.toString('utf8') : '')).join('');
  assert.match(reportText, /unpack ok\n/);
  assert.match(reportText, /ok refs\/heads\/main\n/);

  // The REST surface sees the pushed branch.
  const branches = await api('GET', `/api/v3/repos/${OWNER}/git-roundtrip/branches`);
  assert.equal(branches.json.find((b: any) => b.name === 'main').commit.sha, commit2Oid);

  // ls-refs over protocol v2.
  const lsRequest = Buffer.concat([
    encodePktLine('command=ls-refs\n'),
    encodePktLine('agent=test\n'),
    Buffer.from('0001', 'ascii'),
    encodePktLine('peel\n'),
    encodePktLine('symrefs\n'),
    pktFlush(),
  ]);
  const lsResponse = await gitPost(`${gitPath}/git-upload-pack`, lsRequest, 'version=2');
  const lsPackets = decodePktStream(lsResponse);
  assert.ok(lsPackets);
  const lsText = lsPackets.packets.map((p) => (p.kind === 'data' ? p.payload.toString('utf8') : '')).join('');
  assert.match(lsText, new RegExp(`${commit2Oid} refs/heads/main`));
  assert.match(lsText, /HEAD symref-target:refs\/heads\/main/);

  // Fetch the tip over v2 and verify the pack carries byte-identical objects.
  const fetchRequest = Buffer.concat([
    encodePktLine('command=fetch\n'),
    Buffer.from('0001', 'ascii'),
    encodePktLine('thin-pack\n'),
    encodePktLine('ofs-delta\n'),
    encodePktLine(`want ${commit2Oid}\n`),
    encodePktLine('done\n'),
    pktFlush(),
  ]);
  const fetchResponse = await gitPost(`${gitPath}/git-upload-pack`, fetchRequest, 'version=2');
  const fetchPackets = decodePktStream(fetchResponse);
  assert.ok(fetchPackets);
  let inPackfile = false;
  const packChunks: Buffer[] = [];
  for (const packet of fetchPackets.packets) {
    if (packet.kind === 'delim') {
      inPackfile = false;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const payload = packet.payload;
    if (payload.toString('utf8') === 'packfile\n') {
      inPackfile = true;
      continue;
    }
    if (inPackfile && payload.length > 0 && payload[0] === 1) packChunks.push(payload.subarray(1));
  }
  const fetchedPack = Buffer.concat(packChunks);
  const fetched = readPack(fetchedPack);
  assert.ok(fetched);
  const byOid = new Map(fetched.objects.map((o) => [o.oid, o]));
  assert.equal(byOid.get(commit2Oid)?.data.toString('utf8'), commit2.toString('utf8'));
  assert.equal(byOid.get(commit1Oid)?.data.toString('utf8'), commit1.toString('utf8'));
  assert.equal(byOid.get(tree2Oid)?.data.toString('hex'), tree2.toString('hex'));
  assert.equal(byOid.get(blob2Oid)?.data.toString('utf8'), 'two\n');

  // A REST contents commit lands in the same store and clones too.
  const restWrite = await api('PUT', `/api/v3/repos/${OWNER}/git-roundtrip/contents/c.txt`, {
    message: 'rest commit',
    content: Buffer.from('three\n').toString('base64'),
  });
  assert.equal(restWrite.status, 201);
  const commits = await api('GET', `/api/v3/repos/${OWNER}/git-roundtrip/commits`);
  assert.ok(commits.json.some((c: any) => c.commit.message === 'rest commit'));
});
