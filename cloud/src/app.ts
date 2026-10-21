// Synclium Cloud's HTTP contract as one Request -> Response function. main.ts serves it over node:http; tests, and
// the extension's tests, call `handle` in process as their `fetch`.
//
//   GET     /v1/health           200 {"ok":true}            no auth, no rate limit; 503 when the database fails
//   OPTIONS any path             204 preflight              no auth
//   GET     /v1/o/ or <prefix>/  200 {"names":[...]}        direct children, sorted, unique; [] for an unknown vault
//   GET     /v1/o/<key>          200 bytes + ETag | 304 | 404
//   PUT     /v1/o/<key>          204 + ETag | 413 | 503 | 507
//   DELETE  /v1/o/<key>          204, present or not
//   other                        404 path, 405 method
// Authed routes answer 401 without `Authorization: Bearer <43 base64url chars>`, 400 for a key outside the
// grammar (vaults.ts `keyOf`), and every route but health 429 + Retry-After past the client's rate.
//
// CORS: only extension origins. A request with any other Origin is refused (403) without CORS headers; one with
// no Origin (curl, health checks) is served. Every answer to an extension origin carries the CORS headers, errors
// included: without them Chromium hides the status, and a 507 would read as "unreachable".
import { createHash } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import { LIMITS, isFull, take, type Bucket, type Limits, type Rate } from './limits.ts';
import { keyOf, prefixOf, vaultOf, type ObjectKey, type Prefix, type VaultId, type Vaults } from './vaults.ts';

/** What the disk guard reads. main.ts measures it: free space on the volume, and the database with its WAL. */
export type Disk = { readonly freeBytes: number; readonly dataBytes: number };

export type CloudDeps = {
  readonly vaults: Vaults;
  readonly limits?: Partial<Limits>;
  /** ms since the epoch. Rate limits and each object's `updated` read it. */
  readonly now?: () => number;
  readonly disk?: () => Disk;
};

/** Who sent a request. `ip` is the rate-limit identity (main.ts: the last X-Forwarded-For entry). */
export type Client = { readonly ip: string };

export type Cloud = {
  /** Never rejects: an unexpected throw is logged and answers 500, with CORS headers. */
  readonly handle: (request: Request, client: Client) => Promise<Response>;
};

type Route =
  | { readonly kind: 'health' }
  | { readonly kind: 'preflight' }
  | { readonly kind: 'list'; readonly prefix: Prefix }
  | { readonly kind: 'get'; readonly key: ObjectKey }
  | { readonly kind: 'put'; readonly key: ObjectKey }
  | { readonly kind: 'delete'; readonly key: ObjectKey }
  | { readonly kind: 'refused'; readonly status: 400 | 404 | 405 };

/** An answer before the CORS and caching headers every response shares. */
type Answer = { readonly status: number; readonly headers?: Readonly<Record<string, string>>; readonly body?: Uint8Array<ArrayBuffer> | string };

const OBJECTS = '/v1/o/';
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const PREFLIGHT: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Methods': 'GET, PUT, DELETE',
  'Access-Control-Allow-Headers': 'Authorization, If-None-Match, Content-Type',
  // Chromium caps a preflight cache entry at 2 h. Entries are per URL, and a device's URLs are stable.
  'Access-Control-Max-Age': '7200',
};
const SWEEP_MS = 60_000;

/** The route for a method and a raw, still percent-encoded path. */
function routeOf(method: string, path: string): Route {
  if (method === 'OPTIONS') return { kind: 'preflight' };
  if (path === '/v1/health') return method === 'GET' ? { kind: 'health' } : { kind: 'refused', status: 405 };
  if (!path.startsWith(OBJECTS)) return { kind: 'refused', status: 404 };
  const rest = path.slice(OBJECTS.length);
  if (rest === '' || rest.endsWith('/')) {
    const prefix = prefixOf(rest);
    if (prefix === null) return { kind: 'refused', status: 400 };
    return method === 'GET' ? { kind: 'list', prefix } : { kind: 'refused', status: 405 };
  }
  const key = keyOf(rest);
  if (key === null) return { kind: 'refused', status: 400 };
  switch (method) {
    case 'GET':
      return { kind: 'get', key };
    case 'PUT':
      return { kind: 'put', key };
    case 'DELETE':
      return { kind: 'delete', key };
    default:
      return { kind: 'refused', status: 405 };
  }
}

/** A strong ETag over the bytes, so an identical re-put (a republish after a wipe) reads as unchanged to peers. */
function etagOf(body: Uint8Array): string {
  return `"${createHash('sha256').update(body).digest('base64url')}"`;
}

/** RFC 9110 weak comparison, so an If-None-Match a proxy weakened (W/"...") still matches. */
function matches(ifNoneMatch: string | null, etag: string): boolean {
  if (ifNoneMatch === null) return false;
  return ifNoneMatch.split(',').some((tag) => {
    const t = tag.trim();
    return t === '*' || t.replace(/^W\//, '') === etag;
  });
}

/**
 * The body, or 'too-large' once it passes `max`, or 'broken' when the client went away mid-upload. An oversized
 * Content-Length answers before any read; a longer stream is left unread past the cap, and the 413 closes the
 * connection, so no request buffers more than `max` bytes.
 */
async function readCapped(request: Request, max: number): Promise<Uint8Array<ArrayBuffer> | 'too-large' | 'broken'> {
  if (Number(request.headers.get('Content-Length')) > max) return 'too-large';
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const read = await reader.read().catch(() => null);
    if (read === null) return 'broken';
    if (read.done) break;
    size += read.value.byteLength;
    if (size > max) return 'too-large';
    chunks.push(read.value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
}

/** The rate-limit identity of an address: IPv4 as is, IPv6 by its /64, the block one subscriber holds. */
function clientKey(ip: string): string {
  if (!isIPv6(ip)) return ip;
  const lower = ip.toLowerCase();
  if (lower.startsWith('::ffff:') && isIPv4(lower.slice(7))) return lower.slice(7);
  const [head = '', tail] = lower.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const zeros = tail === undefined ? [] : Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0');
  const groups = [...left, ...zeros, ...right].slice(0, 4).map((group) => group.replace(/^0+(?=.)/, ''));
  return `${groups.join(':')}::/64`;
}

/** Token buckets per key for one rate. Full buckets are forgotten once a minute, so memory follows the active set. */
function limiter(rate: Rate): (key: string, now: number) => number {
  const held = new Map<string, Bucket>();
  let swept = 0;
  return (key, now) => {
    if (now - swept >= SWEEP_MS) {
      for (const [k, bucket] of held) if (isFull(bucket, rate, now)) held.delete(k);
      swept = now;
    }
    const { bucket, retryAfterS } = take(held.get(key), rate, now);
    held.set(key, bucket);
    return retryAfterS;
  };
}

const retryAfter = (status: number, seconds: number): Answer => ({ status, headers: { 'Retry-After': String(seconds) } });

/** The Synclium Cloud server over `deps.vaults`. Rate limits live in the returned handler, per process. */
export function createCloud(deps: CloudDeps): Cloud {
  const { vaults } = deps;
  const limits: Limits = { ...LIMITS, ...deps.limits };
  const now = deps.now ?? Date.now;
  const disk = deps.disk ?? (() => ({ freeBytes: Infinity, dataBytes: 0 }));
  const perClient = limiter(limits.requests);
  const newVaultsPerClient = limiter(limits.newVaults);
  let bodiesInFlight = 0;

  function health(): Answer {
    try {
      vaults.ping();
      return { status: 200, headers: { 'Content-Type': 'application/json' }, body: '{"ok":true}' };
    } catch (error) {
      console.error('health check failed:', error instanceof Error ? error.message : String(error));
      return { status: 503 };
    }
  }

  function get(request: Request, vault: VaultId, key: ObjectKey): Answer {
    const stored = vaults.get(vault, key);
    if (stored === null) return { status: 404 };
    if (matches(request.headers.get('If-None-Match'), stored.etag)) return { status: 304, headers: { ETag: stored.etag } };
    return { status: 200, headers: { ETag: stored.etag, 'Content-Type': 'application/octet-stream' }, body: stored.body };
  }

  async function put(request: Request, client: string, vault: VaultId, key: ObjectKey): Promise<Answer> {
    if (bodiesInFlight >= limits.bodiesInFlight) return retryAfter(503, limits.busyRetryAfterS);
    bodiesInFlight++;
    let body: Awaited<ReturnType<typeof readCapped>>;
    try {
      body = await readCapped(request, limits.objectBytes);
    } finally {
      bodiesInFlight--;
    }
    if (body === 'too-large') return { status: 413, headers: { Connection: 'close' } };
    if (body === 'broken') return { status: 400 };
    if (vaults.usage(vault).objects === 0) {
      const wait = newVaultsPerClient(client, now());
      if (wait > 0) return retryAfter(429, wait);
    }
    const { freeBytes, dataBytes } = disk();
    const mayGrow = freeBytes >= limits.minFreeBytes && dataBytes <= limits.maxDataBytes;
    const etag = etagOf(body);
    switch (vaults.put(vault, key, body, etag, now(), mayGrow)) {
      case 'stored':
        return { status: 204, headers: { ETag: etag } };
      case 'over-quota':
        return { status: 507 };
      case 'no-room':
        return retryAfter(503, limits.diskRetryAfterS);
    }
  }

  async function answer(request: Request, client: string): Promise<Answer> {
    const route = routeOf(request.method, new URL(request.url).pathname);
    if (route.kind === 'health') return health();
    const wait = perClient(client, now());
    if (wait > 0) return retryAfter(429, wait);
    if (route.kind === 'refused') return { status: route.status };
    if (route.kind === 'preflight') return { status: 204, headers: PREFLIGHT };
    const vault = vaultOf(request.headers.get('Authorization'));
    if (vault === null) return { status: 401 };
    switch (route.kind) {
      case 'list':
        return { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ names: vaults.list(vault, route.prefix) }) };
      case 'get':
        return get(request, vault, route.key);
      case 'put':
        return put(request, client, vault, route.key);
      case 'delete':
        vaults.delete(vault, route.key);
        return { status: 204 };
    }
  }

  return {
    async handle(request, client) {
      const origin = request.headers.get('Origin');
      if (origin !== null && !EXTENSION_ORIGIN.test(origin)) return new Response(null, { status: 403 });
      let result: Answer;
      try {
        result = await answer(request, clientKey(client.ip));
      } catch (error) {
        console.error('unexpected error:', error instanceof Error ? (error.stack ?? error.message) : String(error));
        result = { status: 500 };
      }
      const headers = new Headers(result.headers);
      if (origin !== null) {
        headers.set('Access-Control-Allow-Origin', origin);
        headers.set('Vary', 'Origin');
        headers.set('Access-Control-Expose-Headers', 'ETag, Retry-After');
      }
      if (request.method === 'GET') headers.set('Cache-Control', 'no-store');
      return new Response(result.body ?? null, { status: result.status, headers });
    },
  };
}
