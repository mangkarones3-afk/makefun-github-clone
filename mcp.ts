// The MCP endpoint: Model Context Protocol over Streamable HTTP (plain JSON answers).
// It speaks the 2026-07-28 revision through server/discover and the legacy initialize
// handshake, and exposes the forge's tools over the same store REST and GraphQL use.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isRecord, parseJsonBody, sendEmpty, sendJson } from './http.ts';
import { VIEWER, branchTip, forge, type IssueState, type RepoState } from './store.ts';
import { createIssueRecord, mergePullRequest } from './rest.ts';

const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly properties: Readonly<Record<string, { type: string; description: string }>>;
  readonly required: readonly string[];
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name' },
      description: { type: 'string', description: 'A short description of the repository' },
      private: { type: 'boolean', description: 'Whether the repository is private' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      title: { type: 'string', description: 'The issue title' },
      body: { type: 'string', description: 'The issue body' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      state: { type: 'string', description: 'open, closed or all' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      title: { type: 'string', description: 'The pull request title' },
      body: { type: 'string', description: 'The pull request body' },
      head: { type: 'string', description: 'The head branch name' },
      base: { type: 'string', description: 'The base branch name' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) and close it.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      pull_number: { type: 'number', description: 'The pull request number' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolListResult(): Record<string, unknown> {
  return {
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(tool.properties).map(([name, schema]) => [name, { type: schema.type, description: schema.description }]),
        ),
        required: [...tool.required],
      },
    })),
  };
}

function repoResult(repo: RepoState): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: repo.owner, id: VIEWER.id },
  };
}

function issueResult(repo: RepoState, issue: IssueState): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: VIEWER.login, id: VIEWER.id },
  };
}

function pullResult(repo: RepoState, pull: IssueState): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: branchTip(repo, pull.headRef) ?? '' },
    base: { ref: pull.baseRef, sha: branchTip(repo, pull.baseRef) ?? '' },
    merged: pull.merged,
    merged_at: pull.merged ? new Date(1_735_689_600_000).toISOString() : null,
    merge_commit_sha: pull.mergeCommitSha,
  };
}

interface ToolOutcome {
  readonly value: unknown;
  readonly isError?: boolean;
}

function callTool(name: string, args: Record<string, unknown>): ToolOutcome | 'unknown' | 'invalid' {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return 'unknown';
  for (const required of tool.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') return 'invalid';
  }
  const repoOf = (): RepoState | null =>
    forge.getRepo(typeof args.owner === 'string' ? args.owner : '', typeof args.repo === 'string' ? args.repo : '');
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (forge.getRepo(VIEWER.login, repoName)) {
        return { value: { message: `a repository named ${repoName} already exists` }, isError: true };
      }
      const repo = forge.createRepo(repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
      return { value: repoResult(repo) };
    }
    case 'get_repo': {
      const repo = repoOf();
      if (!repo) return { value: { message: 'Not Found' }, isError: true };
      return { value: repoResult(repo) };
    }
    case 'create_issue': {
      const repo = repoOf();
      if (!repo) return { value: { message: 'Not Found' }, isError: true };
      const issue = createIssueRecord(repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
      });
      return { value: issueResult(repo, issue) };
    }
    case 'list_issues': {
      const repo = repoOf();
      if (!repo) return { value: { message: 'Not Found' }, isError: true };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = [...repo.issues.values()]
        .filter((issue) => !issue.isPull)
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => b.number - a.number)
        .map((issue) => issueResult(repo, issue));
      return { value: list };
    }
    case 'create_pull_request': {
      const repo = repoOf();
      if (!repo) return { value: { message: 'Not Found' }, isError: true };
      const head = String(args.head).split(':').pop()!;
      const base = String(args.base);
      if (!branchTip(repo, head) || !branchTip(repo, base)) {
        return { value: { message: 'Head or base branch does not exist' }, isError: true };
      }
      const pull = createIssueRecord(repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        isPull: true,
        headRef: head,
        baseRef: base,
      });
      return { value: pullResult(repo, pull) };
    }
    case 'merge_pull_request': {
      const repo = repoOf();
      if (!repo) return { value: { message: 'Not Found' }, isError: true };
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number), 10);
      const pull = repo.issues.get(number);
      if (!pull || !pull.isPull) return { value: { message: 'Not Found' }, isError: true };
      const outcome = mergePullRequest(repo, pull, 'squash');
      if (!outcome.ok) {
        return { value: { message: outcome.reason === 'conflict' ? 'Merge conflict' : 'Pull request is not mergeable' }, isError: true };
      }
      return { value: pullResult(repo, pull) };
    }
    default:
      return 'unknown';
  }
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
  if (req.method === 'DELETE') {
    sendEmpty(res, 200);
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, rpcError(null, -32600, 'Method not allowed'));
    return;
  }
  const parsed = parseJsonBody(body);
  if (!parsed.ok) {
    // The parse-error contract: HTTP 400 with JSON-RPC -32700.
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }
  const request = parsed.value;
  if (Array.isArray(request)) {
    const results = request.map((entry) => (isRecord(entry) ? dispatch(entry) : rpcError(null, -32600, 'Invalid Request')));
    sendJson(res, 200, results);
    return;
  }
  if (!isRecord(request)) {
    sendJson(res, 400, rpcError(null, -32600, 'Invalid Request'));
    return;
  }
  if (request.id === undefined) {
    // A notification: accepted, no answer body.
    sendEmpty(res, 202);
    return;
  }
  sendJson(res, 200, dispatch(request));
}

function dispatch(request: Record<string, unknown>): Record<string, unknown> {
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = isRecord(request.params) ? request.params : {};
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = LEGACY_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, toolListResult());
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      const outcome = callTool(name, args);
      if (outcome === 'unknown') return rpcError(id, -32602, `Unknown tool: ${name}`);
      if (outcome === 'invalid') return rpcError(id, -32602, `Missing required arguments for ${name}`);
      const text = JSON.stringify(outcome.value);
      const result: Record<string, unknown> = {
        content: [{ type: 'text', text }],
        structuredContent: outcome.value,
      };
      if (outcome.isError) result.isError = true;
      return rpcResult(id, result);
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
