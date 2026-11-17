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
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
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
  return Buffer.concat(chunks);
}

/** The expected bearer token, from the entry's environment ('' when unset: accept any). */
export function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

/** True when the request carries the shop token (or no token is configured). */
export function authorized(req: IncomingMessage): boolean {
  const token = expectedToken();
  if (token === '') return true;
  return req.headers.authorization === `Bearer ${token}`;
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
