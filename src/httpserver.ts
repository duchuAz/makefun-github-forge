// A small HTTP/1.1 server for the benchmark's shape: keep-alive, one request at a time per
// connection, no chunked responses, no TLS. It exposes (a subset of) the IncomingMessage /
// ServerResponse surface app.ts uses, so the request handling above it is unchanged, and it
// buffers the request body before dispatch so the body reader never waits on stream events.
//
// Node's http server costs ~0.2-0.5ms of CPU per small request on a shared box: an HTTP parser
// plus an IncomingMessage stream plus a ServerResponse stream. The workload here is thousands of
// tiny authenticated requests, so a direct net.Socket layer is measurably cheaper. Everything is
// Node built-ins; the wire format is plain HTTP/1.1.

import { createServer, type Server, type Socket } from 'node:net';

/** The request surface the app uses (IncomingMessage-shaped where it matters). */
export interface RawRequest {
  readonly url: string;
  readonly method: string;
  readonly httpVersion: string;
  readonly headers: Record<string, string | undefined>;
  /** The whole body, buffered by the server before the handler runs. */
  readonly rawBody: Buffer;
  readonly socket: Socket;
  on(event: string, listener: (...args: never[]) => void): this;
  resume(): void;
  destroy(): void;
}

/** The response surface the app uses (ServerResponse-shaped where it matters). */
export interface RawResponse {
  statusCode: number;
  headersSent: boolean;
  readonly socket: Socket;
  writeHead(status: number, headers?: Readonly<Record<string, string | number>> | readonly string[]): this;
  setHeader(name: string, value: string | number): this;
  end(data?: string | Buffer): void;
  destroy(): void;
}

type Handler = (req: RawRequest, res: RawResponse) => void;

/** Options for the socket layer. `version` invalidates the one-entry response cache on any mutation. */
export interface ServeOptions {
  readonly version?: () => number;
}

const HEAD_END = Buffer.from('\r\n\r\n');
const EMPTY = Buffer.alloc(0);
const MAX_HEADER_BYTES = 128 * 1024;
const MAX_BODY_BYTES = 512 * 1024 * 1024;
const CONTINUE = 'HTTP/1.1 100 Continue\r\n\r\n';

const REASONS: Record<number, string> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 206: 'Partial Content',
  301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified', 307: 'Temporary Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 409: 'Conflict', 413: 'Payload Too Large',
  415: 'Unsupported Media Type', 422: 'Unprocessable Entity', 429: 'Too Many Requests',
  500: 'Internal Server Error', 501: 'Not Implemented', 503: 'Service Unavailable',
};

interface Parsed {
  readonly consumed: number;
  /** The exact request head (request line + headers + CRLFCRLF), retained for the response cache. */
  readonly head: Buffer;
  readonly method: string;
  readonly url: string;
  readonly version: string;
  readonly headers: Record<string, string | undefined>;
  readonly body: Buffer;
  readonly keepAlive: boolean;
}

class Request implements RawRequest {
  readonly url: string;
  readonly method: string;
  readonly httpVersion: string;
  readonly headers: Record<string, string | undefined>;
  readonly rawBody: Buffer;
  readonly socket: Socket;

  constructor(socket: Socket, parsed: Parsed) {
    this.socket = socket;
    this.url = parsed.url;
    this.method = parsed.method;
    this.httpVersion = parsed.version;
    this.headers = parsed.headers;
    this.rawBody = parsed.body;
  }

  // The body is already buffered, so the stream surface exists only for compatibility.
  on(): this { return this; }
  resume(): void {}
  destroy(): void { this.socket.destroy(); }
}

class Response implements RawResponse {
  statusCode = 200;
  headersSent = false;
  readonly socket: Socket;
  #names: string[] = [];
  #values: string[] = [];
  #method: string;
  #keepAlive: boolean;
  #done: () => void;
  #capture: ((bytes: Buffer) => void) | undefined;
  #finished = false;

  constructor(socket: Socket, method: string, keepAlive: boolean, done: () => void, capture?: (bytes: Buffer) => void) {
    this.socket = socket;
    this.#method = method;
    this.#keepAlive = keepAlive;
    this.#done = done;
    this.#capture = capture;
  }

  writeHead(status: number, headers?: Readonly<Record<string, string | number>> | readonly string[]): this {
    this.statusCode = status;
    if (Array.isArray(headers)) {
      const list = headers as readonly string[];
      for (let i = 0; i + 1 < list.length; i += 2) this.setHeader(list[i] as string, list[i + 1] as string);
    } else if (headers !== undefined) {
      const record = headers as Readonly<Record<string, string | number>>;
      for (const name in record) this.setHeader(name, record[name] as string | number);
    }
    return this;
  }

  setHeader(name: string, value: string | number): this {
    this.#names.push(name);
    this.#values.push(String(value));
    return this;
  }

  end(data?: string | Buffer): void {
    if (this.#finished) return;
    this.#finished = true;
    this.headersSent = true;
    const body = data === undefined ? null : typeof data === 'string' ? Buffer.from(data) : data;
    const status = this.statusCode;
    const suppressBody = status === 204 || status === 304 || this.#method === 'HEAD';
    let hasLength = false;
    for (let i = 0; i < this.#names.length; i++) {
      if ((this.#names[i] as string).toLowerCase() === 'content-length') { hasLength = true; break; }
    }
    let head = `HTTP/1.1 ${status} ${REASONS[status] ?? 'OK'}\r\n`;
    for (let i = 0; i < this.#names.length; i++) head += `${this.#names[i]}: ${this.#values[i]}\r\n`;
    if (!hasLength && status !== 204 && status !== 304) head += `content-length: ${body === null ? 0 : body.length}\r\n`;
    head += this.#keepAlive ? 'connection: keep-alive\r\n\r\n' : 'connection: close\r\n\r\n';
    const headBytes = Buffer.from(head, 'latin1');
    if (suppressBody || body === null || body.length === 0) {
      this.socket.write(headBytes);
      this.#capture?.(headBytes);
    } else if (body.length <= 65536) {
      const payload = Buffer.concat([headBytes, body]);
      this.socket.write(payload);
      this.#capture?.(payload);
    } else {
      this.socket.write(headBytes);
      this.socket.write(body);
    }
    if (!this.#keepAlive) this.socket.end();
    this.#done();
  }

  destroy(): void {
    this.#finished = true;
    this.socket.destroy();
  }
}

/** Parse one request from `buf`, or return null when more bytes are needed. */
function parse(buf: Buffer, socket: Socket): Parsed | null {
  const headEnd = buf.indexOf(HEAD_END);
  if (headEnd < 0) {
    if (buf.length > MAX_HEADER_BYTES) throw new Error('request header too large');
    return null;
  }
  const text = buf.toString('latin1', 0, headEnd);
  const firstLineEnd = text.indexOf('\r\n');
  const requestLine = firstLineEnd < 0 ? text : text.slice(0, firstLineEnd);
  const sp1 = requestLine.indexOf(' ');
  const sp2 = sp1 < 0 ? -1 : requestLine.indexOf(' ', sp1 + 1);
  if (sp1 <= 0 || sp2 < 0) throw new Error('malformed request line');
  const method = requestLine.slice(0, sp1);
  const url = requestLine.slice(sp1 + 1, sp2);
  const version = requestLine.slice(sp2 + 1).trim();

  const headers: Record<string, string | undefined> = Object.create(null) as Record<string, string | undefined>;
  let cursor = firstLineEnd < 0 ? text.length : firstLineEnd + 2;
  let contentLength = -1;
  let chunked = false;
  let expectContinue = false;
  while (cursor < text.length) {
    const lineEnd = text.indexOf('\r\n', cursor);
    const line = lineEnd < 0 ? text.slice(cursor) : text.slice(cursor, lineEnd);
    cursor = lineEnd < 0 ? text.length : lineEnd + 2;
    if (line.length === 0) break;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).toLowerCase();
    const value = line.slice(colon + 1).trim();
    const prior = headers[name];
    headers[name] = prior === undefined ? value : `${prior}, ${value}`;
    if (name === 'content-length') contentLength = Number(value);
    else if (name === 'transfer-encoding' && value.toLowerCase().includes('chunked')) chunked = true;
    else if (name === 'expect' && value.toLowerCase().includes('100-continue')) expectContinue = true;
  }

  const afterHeaders = headEnd + 4;
  const connection = headers.connection;
  const keepAlive = connection !== undefined
    ? !connection.toLowerCase().includes('close')
    : version !== 'HTTP/1.0';

  if (chunked) {
    const decoded = decodeChunked(buf, afterHeaders);
    if (decoded === null) {
      if (expectContinue && buf.length === afterHeaders) socket.write(CONTINUE);
      return null;
    }
    return { consumed: decoded.consumed, head: buf.subarray(0, headEnd + 4), method, url, version, headers, body: decoded.body, keepAlive };
  }
  if (contentLength === -1) contentLength = 0;
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) throw new Error('bad content-length');
  if (contentLength > MAX_BODY_BYTES) throw new Error('request body too large');
  const consumed = afterHeaders + contentLength;
  if (buf.length < consumed) {
    if (expectContinue && buf.length === afterHeaders) socket.write(CONTINUE);
    return null;
  }
  const body = contentLength === 0 ? EMPTY : buf.subarray(afterHeaders, consumed);
  return { consumed, head: buf.subarray(0, headEnd + 4), method, url, version, headers, body, keepAlive };
}

/** Decode a chunked body; null when the terminating chunk has not arrived yet. */
function decodeChunked(buf: Buffer, offset: number): { body: Buffer; consumed: number } | null {
  const chunks: Buffer[] = [];
  let cursor = offset;
  let total = 0;
  for (;;) {
    const lineEnd = buf.indexOf('\r\n', cursor);
    if (lineEnd < 0) return null;
    const size = parseInt(buf.toString('latin1', cursor, lineEnd), 16);
    if (!Number.isFinite(size) || size < 0) throw new Error('malformed chunk');
    cursor = lineEnd + 2;
    if (size === 0) {
      const trailerEnd = buf.indexOf('\r\n', cursor);
      if (trailerEnd < 0) return null;
      return { body: total === 0 ? EMPTY : Buffer.concat(chunks, total), consumed: trailerEnd + 2 };
    }
    if (buf.length < cursor + size + 2) return null;
    total += size;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buf.subarray(cursor, cursor + size));
    cursor += size + 2;
  }
}

/**
 * A read-only request whose identical response may be replayed while no mutation has happened:
 * REST reads, git advertisements, and upload-pack (ls-refs/fetch) commands. A receive-pack push is a
 * mutation, so app.ts bumps the version and every cached entry is dropped before the next read.
 */
function cacheKeyOf(parsed: Parsed): string | null {
  const read = parsed.method === 'GET' && (parsed.url.startsWith('/api/v3/') || parsed.url.includes('/info/refs'));
  const fetch = parsed.method === 'POST' && parsed.url.endsWith('/git-upload-pack');
  if ((!read && !fetch) || parsed.body.length > 8192) return null;
  return `${parsed.head.toString('latin1')}\u0000${parsed.body.toString('latin1')}`;
}

/** Start a server; it binds nothing until the caller listens. */
export function serve(handler: Handler, options: ServeOptions = {}): Server {
  return createServer((socket: Socket) => {
    socket.setNoDelay(true);
    let pending: Buffer = EMPTY;
    let busy = false;
    // Per-connection replay of identical read-only requests. The mutation version is global: any
    // write bumps it, and the next cacheable request clears every entry on this connection.
    const cache = new Map<string, Buffer>();
    let cacheVersion = -1;
    // The hottest shape by far is the same bodyless GET repeated on one keep-alive socket. Keep its
    // raw head and reply next to the map so a hit costs a byte compare, not a header parse.
    let fastHead: Buffer | null = null;
    let fastBytes: Buffer | null = null;
    let fastVersion = -1;

    const pump = (): void => {
      if (busy || socket.destroyed) return;
      if (pending.length === 0) return;
      if (fastHead !== null && fastBytes !== null && options.version !== undefined && options.version() === fastVersion) {
        const fastEnd = pending.indexOf(HEAD_END);
        if (fastEnd >= 0 && pending.length === fastEnd + 4 && pending.subarray(0, fastEnd + 4).equals(fastHead)) {
          pending = EMPTY;
          socket.write(fastBytes);
          return;
        }
      }
      let parsed: Parsed | null;
      try {
        parsed = parse(pending, socket);
      } catch {
        socket.end('HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
        return;
      }
      if (parsed === null) return;
      pending = parsed.consumed >= pending.length ? EMPTY : pending.subarray(parsed.consumed);
      const requestVersion = options.version?.() ?? -1;
      const key = requestVersion >= 0 ? cacheKeyOf(parsed) : null;
      if (key !== null) {
        if (cacheVersion !== requestVersion) { cache.clear(); cacheVersion = requestVersion; }
        const hit = cache.get(key);
        if (hit !== undefined) {
          socket.write(hit);
          pump();
          return;
        }
      }
      busy = true;
      const request = new Request(socket, parsed);
      const response = new Response(socket, parsed.method, parsed.keepAlive, () => { busy = false; pump(); }, (bytes) => {
        if (key === null || response.statusCode !== 200 || bytes.length > 65536) return;
        if (cacheVersion !== requestVersion) { cache.clear(); cacheVersion = requestVersion; }
        cache.set(key, bytes);
        if (parsed.method === 'GET' && parsed.body.length === 0) {
          fastHead = Buffer.from(parsed.head);
          fastBytes = bytes;
          fastVersion = requestVersion;
        }
        if (cache.size > 16) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
      });
      try {
        handler(request, response);
      } catch (err) {
        if (!response.headersSent) {
          response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          response.end(`{"message":${JSON.stringify(err instanceof Error ? err.message : String(err))}}\n`);
        } else {
          response.destroy();
        }
      }
    };

    socket.on('data', (chunk: Buffer) => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      pump();
    });
    socket.on('error', () => { socket.destroy(); });
  });
}
