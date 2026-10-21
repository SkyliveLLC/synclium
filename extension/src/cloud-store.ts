// The fourth store: Synclium Cloud, the server in this repo's cloud/ that Skylive runs. Nothing to configure:
// the vault is named by the token the sync key derives (sync-key.ts `vaultTokenFor`), so every device with the
// key finds the same vault, the server never sees the key, and a key nobody has used yet is an empty vault.
//
// That decides the failure model. There is no root that can go missing: an empty vault is a normal answer (a
// first device, or a server that lost its data, after which every device republishes), never an error. So this
// store never reports `missing` or `needs-permission`; it is unreachable, or it refuses (`rejected`).
//
// Fetch rules:
//  - No host permission. The server answers CORS, as Google's API does for drive-store.ts, so choosing Synclium
//    Cloud asks for nothing.
//  - `credentials: 'omit'`, `cache: 'no-store'`, and a timeout per request, body included: a hung request would
//    otherwise hold the cycle lock until Chromium stops the worker. 120 s fits an 8 MiB upload on a slow uplink.
//  - The token rides in `Authorization`, never the URL, so it stays out of proxy logs.
import { StoreError, type Fetched, type ProbeResult, type Store, type StoreConnection, type StoreFailure, type StoreStatus } from './ports.ts';
import type { VaultToken } from './sync-key.ts';
import type { Fetch } from './webdav-store.ts';
import type { Chosen } from './stores.ts';
import { slots } from './local.ts';

/** A build constant, not part of the choice: moving the server is an extension update, and devices republish. */
export const CLOUD_ORIGIN = 'https://synclium.skylive.world';
export const CLOUD_LABEL = 'Synclium Cloud';
const TIMEOUT_MS = 120_000;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The server's statuses in the popup's words. 429 and 5xx pass: the next poll retries, which is the backoff. */
function failureOf(status: number): StoreFailure {
  if (status === 413) return { kind: 'rejected', detail: 'a file is too large' };
  if (status === 507) return { kind: 'rejected', detail: 'this sync group is out of space' };
  if (status === 429) return { kind: 'unreachable', detail: 'busy; Synclium keeps retrying' };
  if (status >= 500) return { kind: 'unreachable', detail: `server error ${status}` };
  // 400 and 401 are this build's bug (a key outside the grammar, a malformed token): said plainly.
  return { kind: 'rejected', detail: `HTTP ${status}` };
}

/** Anything that never got a whole answer (offline, DNS, TLS, CORS refused, the timeout) is unreachable. */
async function onWire<T>(pending: Promise<T>): Promise<T> {
  try {
    return await pending;
  } catch (error) {
    throw new StoreError({ kind: 'unreachable', detail: messageOf(error) });
  }
}

/** One request under the fetch rules above. Rejects only with StoreError. */
function request(fetchFn: Fetch, url: string, init: RequestInit = {}): Promise<Response> {
  return onWire(fetchFn(url, { ...init, credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) }));
}

/** `res` when it succeeded; otherwise its body is drained and the status becomes a StoreError. */
async function expect(res: Response): Promise<Response> {
  if (res.ok) return res;
  await res.body?.cancel();
  throw new StoreError(failureOf(res.status));
}

const isNames = (v: unknown): v is readonly string[] => Array.isArray(v) && v.every((name) => typeof name === 'string');

/** A list answer is `{"names": [...]}`. Anything else is a server this build does not understand. */
function namesOf(text: string): readonly string[] {
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {} // not JSON: refused below like any other unexpected answer
  if (typeof body === 'object' && body !== null && 'names' in body && isNames(body.names)) return body.names;
  throw new StoreError({ kind: 'rejected', detail: 'Synclium Cloud sent an unexpected answer' });
}

/**
 * Store over one vault. A file's version is its ETag (a content hash), sent back as If-None-Match, so an
 * unchanged peer costs one 304. `fetchFn` and `origin` are for tests.
 */
export function cloudStore(token: VaultToken, fetchFn: Fetch = fetch, origin: string = CLOUD_ORIGIN): Store {
  /** `path` is a key, or a prefix that is '' or ends in '/'. Each segment is encoded, so a stray name is a 400, not another path. */
  function send(method: string, path: string, headers: Record<string, string> = {}, body?: BodyInit): Promise<Response> {
    const url = `${origin}/v1/o/${path.split('/').map(encodeURIComponent).join('/')}`;
    return request(fetchFn, url, { method, headers: { Authorization: `Bearer ${token}`, ...headers }, ...(body === undefined ? {} : { body }) });
  }

  async function get(key: string, known: string | null): Promise<Fetched> {
    const res = await send('GET', key, known === null ? {} : { 'If-None-Match': known });
    if (res.status === 304) return { kind: 'unchanged' };
    if (res.status === 404) {
      await res.body?.cancel();
      return { kind: 'missing' };
    }
    await expect(res);
    const version = res.headers.get('ETag');
    if (version !== null && version !== known) return { kind: 'ok', bytes: new Uint8Array(await onWire(res.arrayBuffer())), version };
    await res.body?.cancel();
    // No ETag means the server's CORS headers hide it: every get would download, and unchanged would never hold.
    if (version === null) throw new StoreError({ kind: 'rejected', detail: 'Synclium Cloud sent no version' });
    return { kind: 'unchanged' };
  }

  async function put(key: string, bytes: Uint8Array): Promise<void> {
    const res = await expect(await send('PUT', key, { 'Content-Type': 'application/octet-stream' }, bytes.slice()));
    await res.body?.cancel();
  }

  /** The server answers 204 whether or not the object was there. There are no folders to remove. */
  async function del(key: string): Promise<void> {
    const res = await expect(await send('DELETE', key));
    await res.body?.cancel();
  }

  return {
    async list(prefix) {
      return namesOf(await onWire((await expect(await send('GET', prefix))).text()));
    },
    get,
    put,
    delete: del,
    async probe(): Promise<ProbeResult> {
      // A name of its own, so a probe on another device, or a double click, never reads this one's bytes.
      const probe = `.helium-sync-probe-${crypto.randomUUID()}`;
      try {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        await put(probe, bytes);
        const back = await get(probe, null);
        await del(probe);
        const same = back.kind === 'ok' && back.bytes.length === bytes.length && back.bytes.every((b, i) => b === bytes[i]);
        return same ? { kind: 'ok' } : { kind: 'failed', why: { kind: 'rejected', detail: 'the probe file read back different bytes' } };
      } catch (error) {
        if (error instanceof StoreError) return { kind: 'failed', why: error.why };
        throw error;
      }
    },
  };
}

/** Never prompts and never touches the network: the cycle's first request reports an unreachable server. */
export function connectCloud(token: VaultToken, fetchFn: Fetch = fetch, origin: string = CLOUD_ORIGIN): StoreConnection {
  return { access: 'ready', label: CLOUD_LABEL, store: cloudStore(token, fetchFn, origin) };
}

/** app.html#allow. Nothing to allow: this store never reports needs-permission, so the page never offers it. */
export async function allowCloud(): Promise<StoreStatus> {
  return { access: 'ready', label: CLOUD_LABEL };
}

/**
 * App page, inside the "Use Synclium Cloud" click. No prompt. The vault depends on the key, which the next step
 * decides, so this checks only that the server answers (`GET /v1/health`, no vault, no writes) and saves the
 * choice as `candidate` when it does. The preview that follows reads the vault, and Start probes it.
 */
export async function chooseCloud(fetchFn: Fetch = fetch, origin: string = CLOUD_ORIGIN): Promise<Chosen> {
  try {
    const res = await expect(await request(fetchFn, `${origin}/v1/health`));
    await res.body?.cancel();
  } catch (error) {
    if (error instanceof StoreError) return { kind: 'chosen', label: CLOUD_LABEL, probe: { kind: 'failed', why: error.why } };
    throw error;
  }
  await slots.putCandidate({ kind: 'cloud' });
  return { kind: 'chosen', label: CLOUD_LABEL, probe: { kind: 'ok' } };
}
