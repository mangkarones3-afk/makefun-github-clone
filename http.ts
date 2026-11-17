// Shared HTTP plumbing for the forge's surfaces: body reading, JSON answers with the
// headers the protocol checks require (a JSON content type and an X-GitHub-Request-Id on
// every reply), and the bearer-token gate.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

/** The next request id: a non-empty, ever-increasing value, as GitHub's header carries. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(36).toUpperCase().padStart(6, '0')}`;
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  // Encode once: the buffer's length is the content-length, and ending with the
  // buffer spares the extra byteLength scan and re-encode a string end would pay.
  const buffer = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': buffer.length,
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(buffer);
}

/** sendJson for a body the caller already serialized: identical headers and bytes. */
export function sendJsonBuffer(
  res: ServerResponse,
  status: number,
  body: Buffer,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(body);
}

export function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': nextRequestId() });
  res.end();
}

export function sendBuffer(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(body);
}

/** Read a whole request body (bounded; the suite's largest pack is far below this). */
export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > 512 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(buffer);
  }
  // Most bodies arrive as one chunk; concatenating a single chunk only copies it.
  if (chunks.length === 1) return chunks[0];
  return Buffer.concat(chunks);
}

let tokenCache: string | null = null;

/**
 * The expected bearer token, from the entry's environment ('' when unset: accept
 * any). The environment is fixed before the process serves, so the first read is
 * cached — process.env access on every request was measurable pure overhead.
 */
export function expectedToken(): string {
  if (tokenCache === null) tokenCache = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  return tokenCache;
}

let cachedToken: string | null = null;
let cachedAuthHeader = '';

/** True when the request carries the shop token (or no token is configured). */
export function authorized(req: IncomingMessage): boolean {
  const token = expectedToken();
  if (token === '') return true;
  // The token is fixed for the process's life; build the comparison string once.
  if (token !== cachedToken) {
    cachedToken = token;
    cachedAuthHeader = `Bearer ${token}`;
  }
  return req.headers.authorization === cachedAuthHeader;
}

/** Parse a JSON body; {ok:false} for malformed JSON (distinct from a JSON null). */
export function parseJsonBody(body: Buffer): { ok: boolean; value: unknown } {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) as unknown };
  } catch {
    return { ok: false, value: null };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
