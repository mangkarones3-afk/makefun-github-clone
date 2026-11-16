// The forge's state: repositories, their object stores and refs, labels, issues, pull
// requests and comments — plus the tree-editing and three-way-merge machinery the REST
// contents API and pull-request merges are built on. Everything is in memory and every
// timestamp derives from a counter, never the wall clock, so a run's observable state is
// a pure function of the requests it answered.

import {
  buildCommit,
  buildTree,
  hashObject,
  isAncestor,
  mergeBase,
  parseCommit,
  parseTree,
  putObject,
  type ObjectStore,
  type TreeEntry,
} from './git.ts';

/** The one identity the token names: the scenario's viewer, constant across trials. */
export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

/** 2025-01-01T00:00:00Z: the epoch every generated timestamp counts up from. */
const EPOCH_SEC = 1_735_689_600;

export interface CommentState {
  readonly id: number;
  readonly body: string;
}

export interface IssueState {
  readonly number: number;
  readonly id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly isPull: boolean;
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergeCommitSha: string | null;
  comments: CommentState[];
}

export interface RepoState {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  isPrivate: boolean;
  description: string;
  readonly defaultBranch: string;
  readonly objects: ObjectStore;
  readonly refs: Map<string, string>;
  readonly labels: Map<string, { name: string; color: string }>;
  readonly issues: Map<number, IssueState>;
  nextNumber: number;
  nextCommentId: number;
  commitCounter: number;
}

export class Forge {
  readonly repos = new Map<string, RepoState>();
  private nextRepoId = 1;
  private nextIssueId = 1;

  createRepo(name: string, isPrivate: boolean, description: string): RepoState {
    const repo: RepoState = {
      id: this.nextRepoId++,
      name,
      owner: VIEWER.login,
      isPrivate,
      description,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      commitCounter: 0,
    };
    this.repos.set(`${VIEWER.login}/${name}`, repo);
    return repo;
  }

  /** A repository by owner/name, or null: another owner's repo is indistinguishable from absent. */
  getRepo(owner: string, name: string): RepoState | null {
    if (owner !== VIEWER.login) return null;
    return this.repos.get(`${owner}/${name}`) ?? null;
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER.login) return false;
    return this.repos.delete(`${owner}/${name}`);
  }

  viewerRepos(): RepoState[] {
    return [...this.repos.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  allocIssueId(): number {
    return this.nextIssueId++;
  }
}

/** The forge-wide singleton the HTTP surfaces share. */
export const forge = new Forge();

// ------------------------------------------------------------------ refs and trees

export function branchTip(repo: RepoState, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

export function commitTreeOid(repo: RepoState, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  return commit ? commit.tree : null;
}

/** Flatten a tree into path -> {oid, mode}, recursively. */
export function readTreeFlat(repo: RepoState, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Build nested trees from a flat path -> blob map and store them; answers the root tree id. */
export function writeTreeFlat(repo: RepoState, flat: ReadonlyMap<string, { oid: string; mode: string }>): string {
  interface DirNode {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, DirNode>;
  }
  const root: DirNode = { files: new Map(), dirs: new Map() };
  for (const [path, value] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      let next = node.dirs.get(segments[i]);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(segments[i], next);
      }
      node = next;
    }
    node.files.set(segments[segments.length - 1], value);
  }
  const build = (node: DirNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo.objects, 'tree', buildTree(entries));
  };
  return build(root);
}

/** The flat file map at a branch tip (empty for an unborn branch). */
export function flatAtBranch(repo: RepoState, branch: string): Map<string, { oid: string; mode: string }> {
  const tip = branchTip(repo, branch);
  if (!tip) return new Map();
  const tree = commitTreeOid(repo, tip);
  if (!tree) return new Map();
  return readTreeFlat(repo, tree);
}

/** Commit a flat file map onto a branch (creating the branch when unborn) and move the ref. */
export function commitFlat(
  repo: RepoState,
  branch: string,
  flat: ReadonlyMap<string, { oid: string; mode: string }>,
  message: string,
): string {
  const tree = writeTreeFlat(repo, flat);
  const parent = branchTip(repo, branch);
  repo.commitCounter += 1;
  const commit = buildCommit({
    tree,
    parents: parent ? [parent] : [],
    author: `${VIEWER.name} <${VIEWER.email}>`,
    committer: `${VIEWER.name} <${VIEWER.email}>`,
    timestamp: EPOCH_SEC + repo.commitCounter,
    message: message.endsWith('\n') ? message : `${message}\n`,
  });
  const oid = putObject(repo.objects, 'commit', commit);
  repo.refs.set(`refs/heads/${branch}`, oid);
  return oid;
}

/** Resolve a ref-ish (branch name, tag name, full ref, or commit id) to a commit id. */
export function resolveCommit(repo: RepoState, ref: string): string | null {
  const candidates = [
    repo.refs.get(ref),
    repo.refs.get(`refs/heads/${ref}`),
    repo.refs.get(`refs/tags/${ref}`),
    repo.objects.has(ref) ? ref : undefined,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const object = repo.objects.get(candidate);
    if (!object) continue;
    if (object.type === 'commit') return candidate;
    if (object.type === 'tag') {
      // peel one or more tag layers
      let current = candidate;
      for (let hops = 0; hops < 16; hops += 1) {
        const tagObject = repo.objects.get(current);
        if (!tagObject || tagObject.type !== 'tag') break;
        const match = /^object ([0-9a-f]{40})$/m.exec(tagObject.data.toString('utf8'));
        if (!match) break;
        current = match[1];
        const target = repo.objects.get(current);
        if (target && target.type === 'commit') return current;
      }
    }
  }
  return null;
}

// ------------------------------------------------------------------ line diffs

/** Split text into lines the way git counts them (a trailing newline ends the last line). */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** Longest-common-subsequence match pairs between two line arrays (index in a -> index in b). */
export function lcsMatches(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
  // Classic DP over the smaller dimension; suite files are small.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const matches: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      matches.push([i, j]);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return matches;
}

/** Additions/deletions between two texts, by LCS line diff. */
export function lineDiff(baseText: string, headText: string): { additions: number; deletions: number } {
  const a = splitLines(baseText);
  const b = splitLines(headText);
  const common = lcsMatches(a, b).length;
  return { additions: b.length - common, deletions: a.length - common };
}

/**
 * A three-way line merge (diff3). Returns the merged lines, or null on a conflict —
 * a region both sides changed differently.
 */
export function diff3(base: readonly string[], ours: readonly string[], theirs: readonly string[]): string[] | null {
  const matchOurs = new Map(lcsMatches(base, ours));
  const matchTheirs = new Map(lcsMatches(base, theirs));
  const out: string[] = [];
  let i = 0; // base index
  let j = 0; // ours index
  let k = 0; // theirs index
  const baseLen = base.length;
  const oursLen = ours.length;
  const theirsLen = theirs.length;
  const sameLines = (x: readonly string[], xi: number, y: readonly string[], yi: number, count: number): boolean => {
    for (let t = 0; t < count; t += 1) if (x[xi + t] !== y[yi + t]) return false;
    return true;
  };
  while (i < baseLen || j < oursLen || k < theirsLen) {
    // Find the next base line matched on both sides.
    let next = i;
    while (next < baseLen && !(matchOurs.has(next) && matchTheirs.has(next))) next += 1;
    const oEnd = next < baseLen ? matchOurs.get(next)! : oursLen;
    const tEnd = next < baseLen ? matchTheirs.get(next)! : theirsLen;
    const baseChunk = base.slice(i, next);
    const oursChunk = ours.slice(j, oEnd);
    const theirsChunk = theirs.slice(k, tEnd);
    if (sameLines(oursChunk, 0, baseChunk, 0, baseChunk.length) && oursChunk.length === baseChunk.length) {
      out.push(...theirsChunk);
    } else if (sameLines(theirsChunk, 0, baseChunk, 0, baseChunk.length) && theirsChunk.length === baseChunk.length) {
      out.push(...oursChunk);
    } else if (oursChunk.length === theirsChunk.length && sameLines(oursChunk, 0, theirsChunk, 0, oursChunk.length)) {
      out.push(...oursChunk);
    } else {
      return null;
    }
    if (next >= baseLen) break;
    out.push(base[next]);
    i = next + 1;
    j = oEnd + 1;
    k = tEnd + 1;
  }
  return out;
}

// ------------------------------------------------------------------ pull request merges

export interface MergeOutcome {
  readonly ok: boolean;
  readonly treeFlat?: Map<string, { oid: string; mode: string }>;
  readonly conflictPath?: string;
}

/**
 * Three-way merge of the head branch into the base branch, at tree level with a
 * line-level diff3 for files both sides changed. Mirrors what the merge endpoint needs:
 * a clean merged file map, or the first conflicting path.
 */
export function mergeTrees(
  repo: RepoState,
  baseBranch: string,
  headBranch: string,
): MergeOutcome & { mergeBaseOid: string | null; baseTip: string | null; headTip: string | null } {
  const baseTip = branchTip(repo, baseBranch);
  const headTip = branchTip(repo, headBranch);
  if (!baseTip || !headTip) return { ok: false, mergeBaseOid: null, baseTip, headTip, conflictPath: undefined };
  const mb = mergeBase(repo.objects, baseTip, headTip);
  if (!mb) return { ok: false, mergeBaseOid: null, baseTip, headTip };
  if (mb === headTip) {
    // Head is already contained in base: nothing to merge.
    return { ok: false, mergeBaseOid: mb, baseTip, headTip, conflictPath: undefined };
  }
  const flatBase = readTreeFlat(repo, commitTreeOid(repo, mb)!);
  const flatOurs = readTreeFlat(repo, commitTreeOid(repo, baseTip)!);
  const flatTheirs = readTreeFlat(repo, commitTreeOid(repo, headTip)!);
  const result = new Map<string, { oid: string; mode: string }>();
  const paths = new Set<string>([...flatBase.keys(), ...flatOurs.keys(), ...flatTheirs.keys()]);
  const blobText = (oid: string | undefined): string | null => {
    if (!oid) return null;
    const object = repo.objects.get(oid);
    return object && object.type === 'blob' ? object.data.toString('utf8') : null;
  };
  for (const path of paths) {
    const b = flatBase.get(path)?.oid;
    const o = flatOurs.get(path)?.oid;
    const t = flatTheirs.get(path)?.oid;
    if (o === t) {
      if (o) result.set(path, flatOurs.get(path) ?? flatTheirs.get(path)!);
      continue;
    }
    if (b === o) {
      if (t) result.set(path, flatTheirs.get(path)!);
      continue;
    }
    if (b === t) {
      if (o) result.set(path, flatOurs.get(path)!);
      continue;
    }
    // Both sides changed the path differently.
    if (o === undefined || t === undefined || b === undefined) {
      return { ok: false, mergeBaseOid: mb, baseTip, headTip, conflictPath: path };
    }
    const baseText = blobText(b);
    const oursText = blobText(o);
    const theirsText = blobText(t);
    if (baseText === null || oursText === null || theirsText === null) {
      return { ok: false, mergeBaseOid: mb, baseTip, headTip, conflictPath: path };
    }
    const merged = diff3(splitLines(baseText), splitLines(oursText), splitLines(theirsText));
    if (merged === null) return { ok: false, mergeBaseOid: mb, baseTip, headTip, conflictPath: path };
    const text = merged.length === 0 ? '' : `${merged.join('\n')}\n`;
    const oid = putObject(repo.objects, 'blob', Buffer.from(text, 'utf8'));
    result.set(path, { oid, mode: flatOurs.get(path)?.mode ?? '100644' });
  }
  return { ok: true, treeFlat: result, mergeBaseOid: mb, baseTip, headTip };
}

/** The files a pull request changes: merge-base tree vs head tree, with line counts. */
export function pullRequestFiles(
  repo: RepoState,
  baseBranch: string,
  headBranch: string,
): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
  const baseTip = branchTip(repo, baseBranch);
  const headTip = branchTip(repo, headBranch);
  if (!baseTip || !headTip) return [];
  const mb = mergeBase(repo.objects, baseTip, headTip) ?? baseTip;
  const flatBase = readTreeFlat(repo, commitTreeOid(repo, mb)!);
  const flatHead = readTreeFlat(repo, commitTreeOid(repo, headTip)!);
  const files: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
  const paths = new Set<string>([...flatBase.keys(), ...flatHead.keys()]);
  const text = (oid: string | undefined): string => {
    if (!oid) return '';
    const object = repo.objects.get(oid);
    return object && object.type === 'blob' ? object.data.toString('utf8') : '';
  };
  for (const path of [...paths].sort()) {
    const b = flatBase.get(path)?.oid;
    const h = flatHead.get(path)?.oid;
    if (b === h) continue;
    const { additions, deletions } = lineDiff(text(b), text(h));
    files.push({
      filename: path,
      status: b === undefined ? 'added' : h === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return files;
}

/** Whether `ancestor` is an ancestor of `descendant` in this repo (fast-forward test). */
export function repoIsAncestor(repo: RepoState, ancestor: string, descendant: string): boolean {
  return isAncestor(repo.objects, ancestor, descendant);
}

export function hashBlob(repo: RepoState, data: Buffer): string {
  return hashObject('blob', data);
}

export function isoFromCounter(counter: number): string {
  return new Date((EPOCH_SEC + counter) * 1000).toISOString();
}
