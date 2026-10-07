// The second store: a WebDAV server (Nextcloud, ownCloud, Synology, Fastmail, Koofr, rclone serve webdav, …).
// It needs no gesture after setup and no re-grant after a restart. Its cost: the user needs an account, and
// with no encryption in v1 the server sees every URL. Every HTTP hazard lives here, and fetch failures become
// StoreFailures at this boundary only.
//
// Fetch rules:
//  - `credentials: 'omit'` with an explicit Basic header, never the cookie jar: a Nextcloud session cookie
//    turns on its CSRF check and answers 401.
//  - The server's origin is a granted optional host permission, so CORS does not apply. Setup and Allow access
//    request it inside a click; `connectWebdav` only checks it and never prompts.
//  - `cache: 'no-store'`, so a peer's rewrite is never answered from the HTTP cache.
//
// Status mapping: a network TypeError and 5xx are unreachable; 401, 403, 507, and any other status are rejected.
// A 404 below the root is "absent", unless the root itself is gone, which is missing (never an empty store).
import { StoreError, statusOf, type Fetched, type ProbeResult, type Store, type StoreConnection, type StoreFailure, type StoreStatus } from './ports.ts';
import { DEVICES_PREFIX, STORE_NAME, type StoreKey } from './store-format.ts';
import { slots } from './local.ts';
import type { Brand } from './model.ts';
import type { Chosen } from './stores.ts';

/** An absolute http(s) collection URL ending in `/`, without credentials, query, or fragment. Minted by `parseDavUrl`. */
export type DavUrl = Brand<string, 'DavUrl'>;

export type WebdavConfig = {
  /** The store collection itself, which setup resolves from the URL the user typed (`webdavRootIn`). */
  readonly url: DavUrl;
  readonly username: string;
  /** An app password where the provider has them. Plaintext in IndexedDB: v1 has no encryption at rest. */
  readonly password: string;
};

/** `fetch`'s shape, so the tests can stand a fake server in for the network. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const DEVICES = DEVICES_PREFIX.slice(0, -1);
/**
 * Basic auth sends the password with every request, so plain http is allowed only to this machine. Each name
 * needs its twin in manifest.json's optional_host_permissions, or the permission request throws.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1']);

const isDavUrl = (s: string): s is DavUrl => s.endsWith('/');

/** The one DavUrl mint after parsing. Every caller passes a collection URL, so a miss is a bug, not input. */
function davUrl(href: string): DavUrl {
  if (!isDavUrl(href)) throw new Error(`not a collection URL: ${href}`);
  return href;
}

/** Decoded path segments, or null for a malformed escape. */
function segmentsOf(href: string, base: string): readonly string[] | null {
  try {
    return new URL(href, base).pathname.split('/').filter((s) => s !== '').map(decodeURIComponent);
  } catch {
    return null;
  }
}

/** The user's input as a collection URL, or null when it is not one Synclium will send a password to. */
export function parseDavUrl(input: string): DavUrl | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
  if (!secure || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return null;
  if (segmentsOf(url.href, url.href) === null) return null; // a stray '%' that labelOf could not decode
  return davUrl(url.pathname.endsWith('/') ? url.href : `${url.href}/`);
}

/** The runtime host permission for the server. Match patterns ignore the port. */
export function originPattern(url: DavUrl): string {
  const { protocol, hostname } = new URL(url);
  return `${protocol}//${hostname}/*`;
}

/** "Helium Sync on cloud.example.com", for the popup's sentences. */
export function labelOf(config: WebdavConfig): string {
  const url = new URL(config.url);
  return `${segmentsOf(url.href, url.href)?.at(-1) ?? url.hostname} on ${url.host}`;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function failureOf(status: number): StoreFailure {
  if (status === 401) return { kind: 'rejected', detail: 'wrong username or password' };
  if (status === 403) return { kind: 'rejected', detail: 'access denied' };
  if (status === 507) return { kind: 'rejected', detail: 'the server is out of space' };
  if (status >= 500) return { kind: 'unreachable', detail: `server error ${status}` };
  return { kind: 'rejected', detail: `HTTP ${status}` };
}

const XML_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const HREF = /<(?:[\w.-]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?href\s*>/gi;

/**
 * Names directly under the collection at `dir`, from a PROPFIND Depth: 1 multistatus. No DOMParser in a service
 * worker, and only hrefs matter, so a scanner reads them: any namespace prefix, absolute or path-only hrefs, and
 * any percent-encoding.
 *
 * The rows are the collection and its children, but a reverse proxy or a server that canonicalizes the user may
 * spell the collection's path differently from the URL we sent, so rows are never matched against `dir`'s path.
 * The collection is the shallowest row; the children are one segment deeper. When every row is equally deep,
 * the one row is the collection only if it carries `dir`'s own name: misreading a non-empty folder as empty
 * would let `delete` remove it, and DELETE on a collection is recursive.
 */
export function childNames(xml: string, dir: string): readonly string[] {
  const rows: (readonly string[])[] = [];
  for (const [, raw = ''] of xml.matchAll(HREF)) {
    const row = segmentsOf(raw.trim().replace(/&(amp|lt|gt|quot|apos);/g, (_, entity: string) => XML_ENTITIES[entity] ?? ''), dir);
    if (row !== null) rows.push(row); // a malformed escape: not a name we could have written
  }
  if (rows.length === 0) return [];
  const top = Math.min(...rows.map((row) => row.length));
  const shallowest = rows.filter((row) => row.length === top);
  const own = segmentsOf(dir, dir)?.at(-1)?.toLowerCase() ?? '';
  const hasSelf = rows.some((row) => row.length === top + 1) || (shallowest.length === 1 && (shallowest[0]?.at(-1)?.toLowerCase() ?? '') === own);
  const depth = hasSelf ? top + 1 : top;
  return [...new Set(rows.filter((row) => row.length === depth).map((row) => row.at(-1) ?? ''))].filter((name) => name !== '').sort();
}

const PROPFIND_BODY = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>';

/** Basic auth over UTF-8, which every server we target accepts. */
function basic(config: WebdavConfig): string {
  const bytes = new TextEncoder().encode(`${config.username}:${config.password}`);
  return `Basic ${btoa(String.fromCharCode(...bytes))}`;
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `sha256:${Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** The raw protocol under `config.url`. Every method rejects only with StoreError. */
function dav(config: WebdavConfig, fetchFn: Fetch) {
  const auth = basic(config);
  /** Each key segment percent-encoded, so "Helium Sync" and any other name round-trip. */
  const urlOf = (path: string): string => config.url + path.split('/').map(encodeURIComponent).join('/');

  async function send(method: string, path: string, init: { readonly headers?: Record<string, string>; readonly body?: BodyInit } = {}): Promise<Response> {
    try {
      return await fetchFn(urlOf(path), {
        method,
        headers: { Authorization: auth, ...init.headers },
        ...(init.body === undefined ? {} : { body: init.body }),
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch (error) {
      // fetch rejects with a TypeError for DNS, TLS, offline, and a host permission revoked mid-cycle alike.
      throw new StoreError({ kind: 'unreachable', detail: messageOf(error) });
    }
  }

  /** `res` when its status is one of `ok`; otherwise its body is drained and the status becomes a StoreError. */
  async function expect(res: Response, ...ok: readonly number[]): Promise<Response> {
    if (ok.includes(res.status) || (ok.length === 0 && res.ok)) return res;
    await res.body?.cancel();
    throw new StoreError(failureOf(res.status));
  }

  /** null when the collection does not exist. `dir` is '' for the root, else ends in '/'. */
  async function names(dir: string): Promise<readonly string[] | null> {
    const res = await send('PROPFIND', dir, { headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' }, body: PROPFIND_BODY });
    if (res.status === 404) return null;
    return childNames(await (await expect(res, 207)).text(), urlOf(dir));
  }

  /** A 404 below the root means the entry is absent, unless the root itself is gone. */
  async function absent<T>(value: T): Promise<T> {
    if ((await names('')) === null) throw new StoreError({ kind: 'missing' });
    return value;
  }

  /** 405 is "already exists". */
  async function mkcol(dir: string): Promise<void> {
    await expect(await send('MKCOL', dir), 201, 405);
  }

  return { send, expect, names, absent, mkcol };
}

/** The folders `key` sits in, shallowest first: `a/b/c.x` -> `a/`, `a/b/`. */
function parentsOf(key: string): readonly string[] {
  const segments = key.split('/').slice(0, -1);
  return segments.map((_, i) => `${segments.slice(0, i + 1).join('/')}/`);
}

/**
 * Store over a WebDAV collection. A file's version is its ETag, sent back as If-None-Match so an unchanged peer
 * costs one 304. A server without ETags gets a content hash: every get downloads, but unchanged still holds.
 */
export function webdavStore(config: WebdavConfig, fetchFn: Fetch = fetch): Store {
  const { send, expect, names, absent, mkcol } = dav(config, fetchFn);

  async function put(key: string, bytes: Uint8Array): Promise<void> {
    const body = bytes.slice(); // an ArrayBuffer-backed copy, which BodyInit takes
    const first = await send('PUT', key, { body });
    // 409 (most servers) or 404 (some): a parent collection is missing. Make each, then retry once.
    if (first.status !== 409 && first.status !== 404) {
      await expect(first);
      return;
    }
    await first.body?.cancel();
    await absent(undefined); // a deleted store is missing, not a parent to recreate
    for (const dir of parentsOf(key)) await mkcol(dir);
    await expect(await send('PUT', key, { body }));
  }

  async function del(key: string): Promise<void> {
    const res = await send('DELETE', key);
    if (res.status === 404) return absent(undefined);
    await expect(res);
  }

  return {
    async list(prefix) {
      return (await names(prefix)) ?? absent([]);
    },
    async get(key, known): Promise<Fetched> {
      const etagged = known !== null && !known.startsWith('sha256:');
      const res = await send('GET', key, { headers: etagged ? { 'If-None-Match': known } : {} });
      if (res.status === 304) return { kind: 'unchanged' };
      if (res.status === 404) return absent({ kind: 'missing' });
      const bytes = new Uint8Array(await (await expect(res, 200)).arrayBuffer());
      const version = res.headers.get('ETag') ?? (await sha256(bytes));
      return version === known ? { kind: 'unchanged' } : { kind: 'ok', bytes, version };
    },
    put,
    async delete(key) {
      await del(key);
      // Remove the folders the delete emptied, deepest first. devices/ itself stays: it marks a store.
      for (const dir of parentsOf(key).filter((d) => d !== DEVICES_PREFIX).reverse()) {
        if (((await names(dir)) ?? []).length > 0) return;
        await del(dir);
      }
    },
    async probe(): Promise<ProbeResult> {
      // A name of its own, so a probe on another device, or a double click, never reads this one's bytes.
      const probe = `.helium-sync-probe-${crypto.randomUUID()}`;
      try {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        await put(probe, bytes);
        const back = new Uint8Array(await (await expect(await send('GET', probe), 200)).arrayBuffer());
        await del(probe);
        const same = back.length === bytes.length && back.every((b, i) => b === bytes[i]);
        return same ? { kind: 'ok' } : { kind: 'failed', why: { kind: 'rejected', detail: 'the probe file read back different bytes' } };
      } catch (error) {
        if (error instanceof StoreError) return { kind: 'failed', why: error.why };
        throw error;
      }
    },
  };
}

/**
 * The store inside the collection the user typed, by the folder rule (folder-store.ts `storeRootIn`), so every
 * device may type the same address:
 *   url has devices/               -> url
 *   url has "Helium Sync/devices/" -> that child
 *   otherwise                      -> "Helium Sync/" inside url, created with its devices/
 * Rejects with StoreError: missing when `url` itself does not exist.
 */
export async function webdavRootIn(config: WebdavConfig, fetchFn: Fetch = fetch): Promise<WebdavConfig> {
  const { names, mkcol } = dav(config, fetchFn);
  const top = await names('');
  if (top === null) throw new StoreError({ kind: 'missing' });
  if (top.includes(DEVICES)) return config;
  const store = `${STORE_NAME}/`;
  const inner = top.includes(STORE_NAME) ? await names(store) : null;
  if (inner === null || !inner.includes(DEVICES)) {
    await mkcol(store);
    await mkcol(`${store}${DEVICES_PREFIX}`);
  }
  return { ...config, url: davUrl(`${config.url}${encodeURIComponent(STORE_NAME)}/`) };
}

/** Never prompts and never touches the network: the cycle's first request reports an unreachable server. */
export async function connectWebdav(config: WebdavConfig, fetchFn: Fetch = fetch): Promise<StoreConnection> {
  const label = labelOf(config);
  if (!(await chrome.permissions.contains({ origins: [originPattern(config.url)] }))) return { access: 'failed', label, why: { kind: 'needs-permission' } };
  return { access: 'ready', label, store: webdavStore(config, fetchFn) };
}

/** App page, inside a click, for app.html#allow: asks for the server's host permission again, first thing. */
export async function allowWebdav(config: WebdavConfig): Promise<StoreStatus> {
  await chrome.permissions.request({ origins: [originPattern(config.url)] });
  return statusOf(await connectWebdav(config));
}

/**
 * App page, inside the Connect click: the host permission prompt, then find or create the store, then probe.
 * Saved as `candidate` only when the probe passed, as a picked folder is.
 */
export async function chooseWebdav(typed: WebdavConfig): Promise<Chosen> {
  // First, while the click's gesture is live: Chromium refuses a permission request without one.
  if (!(await chrome.permissions.request({ origins: [originPattern(typed.url)] }))) return { kind: 'cancelled' };
  let config: WebdavConfig;
  try {
    config = await webdavRootIn(typed);
  } catch (error) {
    if (!(error instanceof StoreError)) throw error;
    return { kind: 'chosen', label: labelOf(typed), probe: { kind: 'failed', why: error.why } };
  }
  const probe = await webdavStore(config).probe();
  if (probe.kind === 'ok') await slots.putCandidate({ kind: 'webdav', config });
  return { kind: 'chosen', label: labelOf(config), probe };
}
