// The forge's HTTP server: a health probe, then bearer-authenticated dispatch to the
// git smart-HTTP handlers, REST v3, GraphQL v4 and the MCP endpoint. Everything else is
// a JSON 404, GitHub-style. main.ts owns the lifecycle; this file is only the surface.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { authorized, readBody, sendJson } from './http.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git-http.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendHealth(res: ServerResponse): void {
  const text = '{"ok":true}\n';
  res.writeHead(200, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function pathOf(req: IncomingMessage): URL | null {
  try {
    return new URL(req.url ?? '/', 'http://entry');
  } catch {
    return null;
  }
}

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const url = pathOf(req);
  if (!url) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const path = url.pathname;

  if (method === 'GET' && path === '/healthz') {
    sendHealth(res);
    return;
  }

  const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  const body = needsBody ? await readBody(req) : Buffer.alloc(0);

  // Every other surface sits behind the shop token.
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }

  const gitMatch = GIT_PATH.exec(path);
  if (gitMatch) {
    const owner = decodeSegment(gitMatch[1]);
    const repo = decodeSegment(gitMatch[2]);
    const endpoint = gitMatch[3];
    if (endpoint === 'info/refs' && method === 'GET') {
      handleInfoRefs(req, res, url, owner, repo);
      return;
    }
    if (endpoint === 'git-upload-pack' && method === 'POST') {
      handleUploadPack(req, res, owner, repo, body);
      return;
    }
    if (endpoint === 'git-receive-pack' && method === 'POST') {
      handleReceivePack(req, res, owner, repo, body);
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
    await handleRest(req, res, url, body);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
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
