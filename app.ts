// The forge's HTTP server: a health probe, then bearer-authenticated dispatch to the
// git smart-HTTP handlers, REST v3, GraphQL v4 and the MCP endpoint. Everything else is
// a JSON 404, GitHub-style. main.ts owns the lifecycle; this file is only the surface.
//
// The request target is split by hand: the WHATWG URL parser was the single most
// expensive line of the old dispatch, and for the origin-form targets the suite
// sends, an indexOf('?') split is exactly equivalent. Targets that could parse
// differently (backslashes, dot segments, non-origin forms) still go through the
// real parser. Two REST shapes additionally get fast paths — the single-issue read
// (answered synchronously, before any promise is created) and the issue create —
// which reach the same response code in rest.ts as the general router, minus the
// router's segment machinery and async layers.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { authorized, readBody, sendJson } from './http.ts';
import { handleRest, serveIssueCreate, serveIssueGet } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git-http.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const HEALTH_BODY = Buffer.from('{"ok":true}\n', 'utf8');
const EMPTY_BODY = Buffer.alloc(0);

function sendHealth(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': JSON_TYPE, 'content-length': HEALTH_BODY.length });
  res.end(HEALTH_BODY);
}

interface Target {
  readonly path: string;
  readonly rawQuery: string;
}

/** Split a request target into path + raw query, or null when it does not parse. */
function parseTarget(req: IncomingMessage): Target | null {
  const target = req.url ?? '/';
  if (target.startsWith('/') && !target.includes('\\') && !target.includes('/.')) {
    const q = target.indexOf('?');
    return q < 0 ? { path: target, rawQuery: '' } : { path: target.slice(0, q), rawQuery: target.slice(q + 1) };
  }
  try {
    const url = new URL(target, 'http://entry');
    return { path: url.pathname, rawQuery: url.search.startsWith('?') ? url.search.slice(1) : '' };
  } catch {
    return null;
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

const GIT_ENDPOINTS = new Set(['info/refs', 'git-upload-pack', 'git-receive-pack']);

/** Parse /{owner}/{repo}.git/{endpoint} by scanning (the old code ran a regex). */
function parseGitPath(path: string): { owner: string; repo: string; endpoint: string } | null {
  const ownerEnd = path.indexOf('/', 1);
  if (ownerEnd < 2) return null;
  const repoEnd = path.indexOf('/', ownerEnd + 1);
  if (repoEnd < 0) return null;
  const repoSegment = path.slice(ownerEnd + 1, repoEnd);
  if (repoSegment.length <= 4 || !repoSegment.endsWith('.git')) return null;
  const endpoint = path.slice(repoEnd + 1);
  if (!GIT_ENDPOINTS.has(endpoint)) return null;
  return {
    owner: decodeSegment(path.slice(1, ownerEnd)),
    repo: decodeSegment(repoSegment.slice(0, -4)),
    endpoint,
  };
}

const REST_PREFIX = '/api/v3/repos/';

/**
 * Match /api/v3/repos/{owner}/{repo}/issues/{digits} exactly (one trailing slash
 * allowed, as the general router's segment collapsing accepts it). Percent-bearing
 * or otherwise unusual shapes return null and take the general router, which
 * decodes and collapses exactly as before.
 */
function matchIssueGet(path: string): { owner: string; repo: string; number: number } | null {
  if (!path.startsWith(REST_PREFIX) || path.includes('%')) return null;
  const ownerEnd = path.indexOf('/', REST_PREFIX.length);
  if (ownerEnd < 0) return null;
  const repoEnd = path.indexOf('/', ownerEnd + 1);
  if (repoEnd < 0) return null;
  const tail = path.slice(repoEnd + 1);
  if (!tail.startsWith('issues/')) return null;
  let digits = tail.slice('issues/'.length);
  if (digits.endsWith('/')) digits = digits.slice(0, -1);
  if (digits === '') return null;
  for (let i = 0; i < digits.length; i += 1) {
    const code = digits.charCodeAt(i);
    if (code < 48 || code > 57) return null;
  }
  return {
    owner: path.slice(REST_PREFIX.length, ownerEnd),
    repo: path.slice(ownerEnd + 1, repoEnd),
    number: Number.parseInt(digits, 10),
  };
}

/** Match /api/v3/repos/{owner}/{repo}/issues (one trailing slash allowed). */
function matchIssueCreate(path: string): { owner: string; repo: string } | null {
  if (!path.startsWith(REST_PREFIX) || path.includes('%')) return null;
  const ownerEnd = path.indexOf('/', REST_PREFIX.length);
  if (ownerEnd < 0) return null;
  const repoEnd = path.indexOf('/', ownerEnd + 1);
  if (repoEnd < 0) return null;
  const tail = path.slice(repoEnd + 1);
  if (tail !== 'issues' && tail !== 'issues/') return null;
  return { owner: path.slice(REST_PREFIX.length, ownerEnd), repo: path.slice(ownerEnd + 1, repoEnd) };
}

/** The single-issue read, answered synchronously when the shape matches. */
function tryServeIssueGet(req: IncomingMessage, res: ServerResponse): boolean {
  const target = req.url ?? '';
  if (!target.startsWith(REST_PREFIX)) return false;
  const q = target.indexOf('?');
  const match = matchIssueGet(q < 0 ? target : target.slice(0, q));
  if (!match) return false;
  try {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return true;
    }
    serveIssueGet(res, match.owner, match.repo, match.number);
  } catch {
    try {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    } catch {
      // The peer is gone; nothing more to do.
    }
  }
  return true;
}

async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const target = parseTarget(req);
  if (!target) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const path = target.path;

  if (method === 'GET' && path === '/healthz') {
    sendHealth(res);
    return;
  }

  const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  const body = needsBody ? await readBody(req) : EMPTY_BODY;

  // Every other surface sits behind the shop token.
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }

  // The issue create, straight to its handler (the general router agrees on the outcome).
  if (method === 'POST') {
    const create = matchIssueCreate(path);
    if (create) {
      serveIssueCreate(res, create.owner, create.repo, body);
      return;
    }
  }

  const git = parseGitPath(path);
  if (git) {
    if (git.endpoint === 'info/refs' && method === 'GET') {
      handleInfoRefs(req, res, target.rawQuery, git.owner, git.repo);
      return;
    }
    if (git.endpoint === 'git-upload-pack' && method === 'POST') {
      handleUploadPack(req, res, git.owner, git.repo, body);
      return;
    }
    if (git.endpoint === 'git-receive-pack' && method === 'POST') {
      handleReceivePack(req, res, git.owner, git.repo, body);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  if (path === '/mcp') {
    await handleMcp(req, res, body);
    return;
  }

  if (path === '/api/graphql' && method === 'POST') {
    await handleGraphql(req, res, body);
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    await handleRest(req, res, path, target.rawQuery, body);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && tryServeIssueGet(req, res)) return;
    dispatch(req, res).catch(() => {
      // A handler failure must never take the server down (the suite probes exactly that).
      try {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      } catch {
        // The peer is gone; nothing more to do.
      }
    });
  });
}
