// The REST v3 surface: root and meta, the viewer's repositories with Link pagination,
// repository get/patch/delete, the contents API over the git object store, git refs and
// branches, commits, labels, issues with comments, and pull requests with merges. Every
// route answers JSON; errors carry a string `message`; unknown routes are a JSON 404.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isRecord, parseJsonBody, sendEmpty, sendJson } from './http.ts';
import {
  VIEWER,
  branchTip,
  commitFlat,
  commitTreeOid,
  flatAtBranch,
  forge,
  isoFromCounter,
  mergeTrees,
  pullRequestFiles,
  readTreeFlat,
  resolveCommit,
  writeTreeFlat,
  type IssueState,
  type RepoState,
} from './store.ts';
import { buildCommit, parseCommit, parseTree, putObject } from './git.ts';

const NOT_FOUND = { message: 'Not Found' };

function repoJson(repo: RepoState): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: repo.owner, id: VIEWER.id },
    html_url: `/${repo.owner}/${repo.name}`,
  };
}

function issueJson(repo: RepoState, issue: IssueState): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    user: { login: VIEWER.login, id: VIEWER.id },
    comments: issue.comments.length,
  };
  if (issue.isPull) body.pull_request = { url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${issue.number}` };
  return body;
}

function pullJson(repo: RepoState, pull: IssueState): Record<string, unknown> {
  const headSha = branchTip(repo, pull.headRef) ?? '';
  const baseSha = branchTip(repo, pull.baseRef) ?? '';
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.merged ? isoFromCounter(pull.number) : null,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: VIEWER.login, id: VIEWER.id },
  };
}

function commentJson(comment: { id: number; body: string }): Record<string, unknown> {
  return { id: comment.id, body: comment.body, user: { login: VIEWER.login, id: VIEWER.id } };
}

/** GitHub-style pagination: slice plus a Link header while more pages remain. */
function paginate<T>(
  res: ServerResponse,
  status: number,
  items: readonly T[],
  query: URLSearchParams,
  baseUrl: string,
): void {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const lastPage = Math.ceil(items.length / perPage);
    const make = (p: number): string => {
      const params = new URLSearchParams(query);
      params.set('page', String(p));
      params.set('per_page', String(perPage));
      return `<${baseUrl}?${params.toString()}>`;
    };
    headers.link = `${make(page + 1)}; rel="next", ${make(lastPage)}; rel="last"`;
  }
  sendJson(res, status, slice, headers);
}

interface Route {
  readonly segments: string[];
  readonly query: URLSearchParams;
  readonly host: string;
}

/** Percent-decode one path segment (never throws). */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer): Promise<void> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  const segments = path.split('/').filter((s) => s !== '').map(decodeSegment);
  const route: Route = { segments, query: url.searchParams, host: req.headers.host ?? 'localhost' };
  const base = `http://${route.host}${path}`;

  // Root and meta.
  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'v3') {
    if (method === 'GET') {
      sendJson(
        res,
        200,
        {
          current_user_url: '/api/v3/user',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          rate_limit_url: '/api/v3/rate_limit',
        },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
      return;
    }
  }
  if (path === '/api/v3/meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0-forge', verifiable_password_authentication: false });
    return;
  }
  if (path === '/api/v3/user' && method === 'GET') {
    sendJson(res, 200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
    return;
  }

  // The viewer's repositories.
  if (path === '/api/v3/user/repos') {
    if (method === 'GET') {
      paginate(res, 200, forge.viewerRepos().map(repoJson), route.query, base);
      return;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok || !isRecord(parsed.value)) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      const name = parsed.value.name;
      if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        sendJson(res, 422, { message: 'Repository creation failed: name is invalid' });
        return;
      }
      if (forge.getRepo(VIEWER.login, name)) {
        sendJson(res, 422, { message: 'Repository creation failed: a repository with this name already exists' });
        return;
      }
      const repo = forge.createRepo(
        name,
        parsed.value.private === true,
        typeof parsed.value.description === 'string' ? parsed.value.description : '',
      );
      sendJson(res, 201, repoJson(repo));
      return;
    }
  }

  // Repository-scoped routes: /api/v3/repos/{owner}/{repo}[/...]
  if (segments.length >= 5 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'repos') {
    const owner = segments[3];
    const repoName = segments[4];
    const repo = forge.getRepo(owner, repoName);
    const rest = segments.slice(5);
    if (!repo) {
      sendJson(res, 404, NOT_FOUND);
      return;
    }
    await handleRepoRoute(req, res, route, repo, rest, body, base);
    return;
  }

  sendJson(res, 404, NOT_FOUND);
}

async function handleRepoRoute(
  req: IncomingMessage,
  res: ServerResponse,
  route: Route,
  repo: RepoState,
  rest: string[],
  body: Buffer,
  base: string,
): Promise<void> {
  const method = req.method ?? 'GET';

  // The repository itself.
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok || !isRecord(parsed.value)) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
      if (typeof parsed.value.private === 'boolean') repo.isPrivate = parsed.value.private;
      if (typeof parsed.value.name === 'string' && parsed.value.name !== repo.name) {
        // Renaming moves the map key; the suite never renames, but stay consistent.
        forge.repos.delete(`${repo.owner}/${repo.name}`);
        (repo as { name: string }).name = parsed.value.name;
        forge.repos.set(`${repo.owner}/${repo.name}`, repo);
      }
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo.owner, repo.name);
      sendEmpty(res, 204);
      return;
    }
    sendJson(res, 404, NOT_FOUND);
    return;
  }

  // Branches.
  if (rest[0] === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha } }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      sendJson(res, 200, branches);
      return;
    }
    if (method === 'GET' && rest.length >= 2) {
      const branch = rest.slice(1).join('/');
      const tip = branchTip(repo, branch);
      if (!tip) {
        sendJson(res, 404, NOT_FOUND);
        return;
      }
      sendJson(res, 200, { name: branch, commit: { sha: tip } });
      return;
    }
    sendJson(res, 404, NOT_FOUND);
    return;
  }

  // Commits.
  if (rest[0] === 'commits') {
    if (method === 'GET' && rest.length === 1) {
      const shaParam = route.query.get('sha');
      const startRef = shaParam && shaParam !== '' ? shaParam : repo.defaultBranch;
      const tip = resolveCommit(repo, startRef);
      if (!tip) {
        sendJson(res, 200, []);
        return;
      }
      const seen = new Set<string>();
      const ordered: string[] = [];
      const queue = [tip];
      while (queue.length) {
        const oid = queue.shift()!;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const object = repo.objects.get(oid);
        if (!object || object.type !== 'commit') continue;
        ordered.push(oid);
        const commit = parseCommit(object.data);
        if (commit) queue.push(...commit.parents);
      }
      const list = ordered.map((oid) => {
        const commit = parseCommit(repo.objects.get(oid)!.data)!;
        return { sha: oid, commit: { message: commit.message.replace(/\n$/, ''), tree: { sha: commit.tree } } };
      });
      paginate(res, 200, list, route.query, base);
      return;
    }
    if (method === 'GET' && rest.length === 2) {
      const object = repo.objects.get(rest[1]);
      if (!object || object.type !== 'commit') {
        sendJson(res, 404, NOT_FOUND);
        return;
      }
      const commit = parseCommit(object.data)!;
      sendJson(res, 200, { sha: rest[1], commit: { message: commit.message.replace(/\n$/, ''), tree: { sha: commit.tree } } });
      return;
    }
    sendJson(res, 404, NOT_FOUND);
    return;
  }

  // Git refs (the Git Data surface the MCP setup leans on).
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const parsed = parseJsonBody(body);
      if (!parsed.ok || !isRecord(parsed.value)) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      const ref = parsed.value.ref;
      const sha = parsed.value.sha;
      if (typeof ref !== 'string' || !ref.startsWith('refs/') || typeof sha !== 'string' || !repo.objects.has(sha)) {
        sendJson(res, 422, { message: 'Invalid ref or object' });
        return;
      }
      if (repo.refs.has(ref)) {
        sendJson(res, 422, { message: 'Reference already exists' });
        return;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha, type: repo.objects.get(sha)!.type } });
      return;
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (!sha) {
        sendJson(res, 404, NOT_FOUND);
        return;
      }
      sendJson(res, 200, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
      return;
    }
    if (method === 'DELETE' && rest.length >= 3) {
      const ref = `refs/${rest.slice(2).join('/')}`;
      if (!repo.refs.delete(ref)) {
        sendJson(res, 404, NOT_FOUND);
        return;
      }
      sendEmpty(res, 204);
      return;
    }
    sendJson(res, 404, NOT_FOUND);
    return;
  }

  // Contents.
  if (rest[0] === 'contents') {
    await handleContents(req, res, route, repo, rest.slice(1).join('/'), body);
    return;
  }

  // Labels.
  if (rest[0] === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      sendJson(res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
      return;
    }
    if (method === 'POST' && rest.length === 1) {
      const parsed = parseJsonBody(body);
      if (!parsed.ok || !isRecord(parsed.value) || typeof parsed.value.name !== 'string' || parsed.value.name === '') {
        sendJson(res, 422, { message: 'Label name is required' });
        return;
      }
      const name = parsed.value.name;
      if (repo.labels.has(name)) {
        sendJson(res, 422, { message: 'Label already exists' });
        return;
      }
      const color = typeof parsed.value.color === 'string' ? parsed.value.color : 'ededed';
      repo.labels.set(name, { name, color });
      sendJson(res, 201, { name, color });
      return;
    }
    sendJson(res, 404, NOT_FOUND);
    return;
  }

  // Issues and pull requests share the number space; the routes split by surface.
  if (rest[0] === 'issues') {
    await handleIssues(req, res, route, repo, rest.slice(1), body, base);
    return;
  }
  if (rest[0] === 'pulls') {
    await handlePulls(req, res, route, repo, rest.slice(1), body, base);
    return;
  }

  sendJson(res, 404, NOT_FOUND);
}

// ------------------------------------------------------------------ contents

async function handleContents(
  req: IncomingMessage,
  res: ServerResponse,
  route: Route,
  repo: RepoState,
  rawPath: string,
  body: Buffer,
): Promise<void> {
  const method = req.method ?? 'GET';
  const path = rawPath.replace(/^\/+|\/+$/g, '');

  if (method === 'GET') {
    const refParam = route.query.get('ref');
    const commit = resolveCommit(repo, refParam && refParam !== '' ? refParam : repo.defaultBranch);
    if (!commit) {
      sendJson(res, 404, NOT_FOUND);
      return;
    }
    const treeOid = commitTreeOid(repo, commit);
    if (!treeOid) {
      sendJson(res, 404, NOT_FOUND);
      return;
    }
    if (path === '') {
      const entries = listTree(repo, treeOid, '');
      sendJson(res, 200, entries);
      return;
    }
    const found = lookupPath(repo, treeOid, path);
    if (!found) {
      sendJson(res, 404, NOT_FOUND);
      return;
    }
    if (found.kind === 'dir') {
      sendJson(res, 200, listTree(repo, found.oid, path));
      return;
    }
    const blob = repo.objects.get(found.oid);
    if (!blob) {
      sendJson(res, 404, NOT_FOUND);
      return;
    }
    sendJson(res, 200, {
      type: 'file',
      name: path.split('/').pop(),
      path,
      sha: found.oid,
      size: blob.data.length,
      encoding: 'base64',
      content: blob.data.toString('base64'),
    });
    return;
  }

  if (method === 'PUT') {
    const parsed = parseJsonBody(body);
    if (!parsed.ok || !isRecord(parsed.value)) {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    const content = parsed.value.content;
    const message = parsed.value.message;
    if (typeof content !== 'string' || typeof message !== 'string') {
      sendJson(res, 422, { message: 'content and message are required' });
      return;
    }
    const branch = typeof parsed.value.branch === 'string' && parsed.value.branch !== '' ? parsed.value.branch : repo.defaultBranch;
    let flat: Map<string, { oid: string; mode: string }>;
    if (branchTip(repo, branch)) {
      flat = flatAtBranch(repo, branch);
    } else if (branch !== repo.defaultBranch && branchTip(repo, repo.defaultBranch)) {
      // A contents write on a new branch starts from the default branch (the MCP setup's fallback).
      flat = flatAtBranch(repo, repo.defaultBranch);
    } else {
      flat = new Map();
    }
    const existing = flat.get(path);
    const givenSha = typeof parsed.value.sha === 'string' ? parsed.value.sha : undefined;
    if (existing) {
      if (givenSha === undefined) {
        sendJson(res, 422, { message: 'sha is required when updating an existing file' });
        return;
      }
      if (givenSha !== existing.oid) {
        sendJson(res, 409, { message: 'The sha does not match the current file' });
        return;
      }
    }
    const data = Buffer.from(content, 'base64');
    const blobOid = putObject(repo.objects, 'blob', data);
    flat.set(path, { oid: blobOid, mode: existing?.mode ?? '100644' });
    const commitSha = commitFlat(repo, branch, flat, message);
    sendJson(res, existing ? 200 : 201, {
      content: { name: path.split('/').pop(), path, sha: blobOid, size: data.length, type: 'file', encoding: 'base64' },
      commit: { sha: commitSha },
    });
    return;
  }

  if (method === 'DELETE') {
    const parsed = parseJsonBody(body);
    if (!parsed.ok || !isRecord(parsed.value)) {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    const branch = typeof parsed.value.branch === 'string' && parsed.value.branch !== '' ? parsed.value.branch : repo.defaultBranch;
    if (!branchTip(repo, branch)) {
      sendJson(res, 404, NOT_FOUND);
      return;
    }
    const flat = flatAtBranch(repo, branch);
    const existing = flat.get(path);
    if (!existing) {
      sendJson(res, 404, NOT_FOUND);
      return;
    }
    const givenSha = typeof parsed.value.sha === 'string' ? parsed.value.sha : undefined;
    if (givenSha !== undefined && givenSha !== existing.oid) {
      sendJson(res, 409, { message: 'The sha does not match the current file' });
      return;
    }
    flat.delete(path);
    const message = typeof parsed.value.message === 'string' ? parsed.value.message : `Delete ${path}`;
    const commitSha = commitFlat(repo, branch, flat, message);
    sendJson(res, 200, { content: null, commit: { sha: commitSha } });
    return;
  }

  sendJson(res, 404, NOT_FOUND);
}

function listTree(repo: RepoState, treeOid: string, prefix: string): Array<Record<string, unknown>> {
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return [];
  return parseTree(object.data).map((entry) => {
    const isDir = entry.mode === '40000';
    const blob = isDir ? null : repo.objects.get(entry.oid);
    return {
      name: entry.name,
      path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
      sha: entry.oid,
      size: blob ? blob.data.length : 0,
      type: isDir ? 'dir' : 'file',
    };
  });
}

function lookupPath(repo: RepoState, treeOid: string, path: string): { kind: 'file' | 'dir'; oid: string; mode: string } | null {
  const segments = path.split('/');
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) {
      return entry.mode === '40000' ? { kind: 'dir', oid: entry.oid, mode: entry.mode } : { kind: 'file', oid: entry.oid, mode: entry.mode };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

// ------------------------------------------------------------------ issues

export function createIssueRecord(
  repo: RepoState,
  fields: { title: string; body: string; labels?: string[]; isPull?: boolean; headRef?: string; baseRef?: string },
): IssueState {
  const issue: IssueState = {
    number: repo.nextNumber++,
    id: forge.allocIssueId(),
    title: fields.title,
    body: fields.body,
    state: 'open',
    labels: fields.labels ?? [],
    isPull: fields.isPull ?? false,
    headRef: fields.headRef ?? '',
    baseRef: fields.baseRef ?? '',
    merged: false,
    mergeCommitSha: null,
    comments: [],
  };
  repo.issues.set(issue.number, issue);
  return issue;
}

async function handleIssues(
  req: IncomingMessage,
  res: ServerResponse,
  route: Route,
  repo: RepoState,
  rest: string[],
  body: Buffer,
  base: string,
): Promise<void> {
  const method = req.method ?? 'GET';

  if (rest.length === 0) {
    if (method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok || !isRecord(parsed.value)) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      const title = parsed.value.title;
      if (typeof title !== 'string' || title === '') {
        sendJson(res, 422, { message: 'Title is required' });
        return;
      }
      const labelNames: string[] = [];
      if (Array.isArray(parsed.value.labels)) {
        for (const label of parsed.value.labels) {
          const name = typeof label === 'string' ? label : isRecord(label) && typeof label.name === 'string' ? label.name : '';
          if (name === '' || !repo.labels.has(name)) {
            sendJson(res, 422, { message: `Label '${name}' does not exist in this repository` });
            return;
          }
          labelNames.push(name);
        }
      }
      const issue = createIssueRecord(repo, {
        title,
        body: typeof parsed.value.body === 'string' ? parsed.value.body : '',
        labels: labelNames,
      });
      sendJson(res, 201, issueJson(repo, issue));
      return;
    }
    if (method === 'GET') {
      const state = route.query.get('state') ?? 'open';
      let list = [...repo.issues.values()].filter((issue) => !issue.isPull);
      if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
      const direction = route.query.get('direction') ?? 'desc';
      list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      paginate(res, 200, list.map((issue) => issueJson(repo, issue)), route.query, base);
      return;
    }
    sendJson(res, 404, NOT_FOUND);
    return;
  }

  const number = Number.parseInt(rest[0], 10);
  const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;

  if (rest.length === 1) {
    if (!issue) {
      sendJson(res, 404, NOT_FOUND);
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
    if (method === 'PATCH') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok || !isRecord(parsed.value)) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      if (parsed.value.state === 'closed' || parsed.value.state === 'open') issue.state = parsed.value.state;
      if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
      if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
      if (Array.isArray(parsed.value.labels)) {
        const names: string[] = [];
        for (const label of parsed.value.labels) {
          const name = typeof label === 'string' ? label : isRecord(label) && typeof label.name === 'string' ? label.name : '';
          if (name === '' || !repo.labels.has(name)) {
            sendJson(res, 422, { message: `Label '${name}' does not exist in this repository` });
            return;
          }
          names.push(name);
        }
        issue.labels = names;
      }
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
    sendJson(res, 404, NOT_FOUND);
    return;
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (!issue) {
      sendJson(res, 404, NOT_FOUND);
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, issue.comments.map(commentJson));
      return;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok || !isRecord(parsed.value) || typeof parsed.value.body !== 'string') {
        sendJson(res, 422, { message: 'Comment body is required' });
        return;
      }
      const comment = { id: repo.nextCommentId++, body: parsed.value.body };
      issue.comments.push(comment);
      sendJson(res, 201, commentJson(comment));
      return;
    }
    sendJson(res, 404, NOT_FOUND);
    return;
  }

  sendJson(res, 404, NOT_FOUND);
}

// ------------------------------------------------------------------ pull requests

/** The shared merge routine (REST PUT /merge, GraphQL mergePullRequest, MCP tool). */
export function mergePullRequest(
  repo: RepoState,
  pull: IssueState,
  method: 'squash' | 'merge' | 'rebase',
): { ok: true; sha: string } | { ok: false; reason: 'conflict' | 'not-mergeable' | 'already-merged' } {
  if (pull.merged) return { ok: false, reason: 'already-merged' };
  if (pull.state !== 'open') return { ok: false, reason: 'not-mergeable' };
  const outcome = mergeTrees(repo, pull.baseRef, pull.headRef);
  if (!outcome.ok || !outcome.treeFlat || !outcome.baseTip || !outcome.headTip) {
    return { ok: false, reason: outcome.conflictPath ? 'conflict' : 'not-mergeable' };
  }
  const tree = writeTreeFlat(repo, outcome.treeFlat);
  repo.commitCounter += 1;
  const parents = method === 'merge' ? [outcome.baseTip, outcome.headTip] : [outcome.baseTip];
  const message =
    method === 'merge'
      ? `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`
      : `${pull.title}\n\n${pull.body}\n`;
  const commit = buildCommit({
    tree,
    parents,
    author: `${VIEWER.name} <${VIEWER.email}>`,
    committer: `${VIEWER.name} <${VIEWER.email}>`,
    timestamp: 1_735_689_600 + repo.commitCounter,
    message,
  });
  const sha = putObject(repo.objects, 'commit', commit);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergeCommitSha = sha;
  return { ok: true, sha };
}

async function handlePulls(
  req: IncomingMessage,
  res: ServerResponse,
  route: Route,
  repo: RepoState,
  rest: string[],
  body: Buffer,
  base: string,
): Promise<void> {
  const method = req.method ?? 'GET';

  if (rest.length === 0) {
    if (method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok || !isRecord(parsed.value)) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      const title = parsed.value.title;
      const head = typeof parsed.value.head === 'string' ? parsed.value.head.split(':').pop()! : '';
      const baseRef = typeof parsed.value.base === 'string' ? parsed.value.base : repo.defaultBranch;
      if (typeof title !== 'string' || title === '' || head === '') {
        sendJson(res, 422, { message: 'Title and head are required' });
        return;
      }
      if (!branchTip(repo, head) || !branchTip(repo, baseRef)) {
        sendJson(res, 422, { message: 'Head or base branch does not exist' });
        return;
      }
      const duplicate = [...repo.issues.values()].find(
        (issue) => issue.isPull && issue.state === 'open' && issue.headRef === head && issue.baseRef === baseRef,
      );
      if (duplicate) {
        sendJson(res, 422, { message: 'A pull request already exists for this head and base' });
        return;
      }
      const pull = createIssueRecord(repo, {
        title,
        body: typeof parsed.value.body === 'string' ? parsed.value.body : '',
        isPull: true,
        headRef: head,
        baseRef,
      });
      sendJson(res, 201, pullJson(repo, pull));
      return;
    }
    if (method === 'GET') {
      const state = route.query.get('state') ?? 'open';
      let list = [...repo.issues.values()].filter((issue) => issue.isPull);
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      list.sort((a, b) => b.number - a.number);
      paginate(res, 200, list.map((pull) => pullJson(repo, pull)), route.query, base);
      return;
    }
    sendJson(res, 404, NOT_FOUND);
    return;
  }

  const number = Number.parseInt(rest[0], 10);
  const pull = Number.isFinite(number) ? repo.issues.get(number) : undefined;
  if (!pull || !pull.isPull) {
    sendJson(res, 404, NOT_FOUND);
    return;
  }

  if (rest.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, pullJson(repo, pull));
      return;
    }
    if (method === 'PATCH') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok || !isRecord(parsed.value)) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      if (parsed.value.state === 'closed' || parsed.value.state === 'open') {
        if (!pull.merged) pull.state = parsed.value.state;
      }
      if (typeof parsed.value.title === 'string') pull.title = parsed.value.title;
      if (typeof parsed.value.body === 'string') pull.body = parsed.value.body;
      sendJson(res, 200, pullJson(repo, pull));
      return;
    }
    sendJson(res, 404, NOT_FOUND);
    return;
  }

  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    sendJson(res, 200, pullRequestFiles(repo, pull.baseRef, pull.headRef));
    return;
  }

  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    const parsed = parseJsonBody(body);
    const methodName =
      parsed.ok && isRecord(parsed.value) && typeof parsed.value.merge_method === 'string'
        ? parsed.value.merge_method
        : 'merge';
    const mergeMethod = methodName === 'squash' ? 'squash' : methodName === 'rebase' ? 'rebase' : 'merge';
    const outcome = mergePullRequest(repo, pull, mergeMethod);
    if (!outcome.ok) {
      if (outcome.reason === 'conflict') {
        sendJson(res, 405, { message: 'Pull Request is not mergeable: merge conflict' });
      } else if (outcome.reason === 'already-merged') {
        sendJson(res, 405, { message: 'Pull Request is not mergeable: already merged' });
      } else {
        sendJson(res, 405, { message: 'Pull Request is not mergeable' });
      }
      return;
    }
    sendJson(res, 200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
    return;
  }

  sendJson(res, 404, NOT_FOUND);
}
