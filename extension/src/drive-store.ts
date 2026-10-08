// The third store: a "Helium Sync" folder in the user's Google Drive. Setup is one click and a Google sign-in,
// and each device signs in to the same account: no folder app to install, no server address, no password kept.
//
// Auth:
//  - chrome.identity.launchWebAuthFlow with Google's token flow. getAuthToken needs Chrome's Google sign-in,
//    which Helium does not have. The flow's redirect is chrome.identity.getRedirectURL(), which the OAuth client
//    (GOOGLE_CLIENT_ID) must list as an authorized redirect URI, one per extension id.
//  - Scope drive.file: Synclium sees only the files it created, never the rest of the Drive. Every device signs
//    in through the same OAuth client, so each sees the folder the first one created.
//  - An access token lasts an hour and is kept in chrome.storage.session (memory only). When it lapses, the
//    worker gets a new one without a window (prompt=none) while the sign-in window's Google session lasts.
//    When that fails the store reads needs-permission, and Allow access signs in again.
//
// Drive addresses files by id, and names need not be unique. Paths resolve one folder at a time, cached for the
// store's life (one cycle). Folders resolve to the oldest of a name, so two devices racing to create one agree;
// files to the newest, though one writer per key means a name has one file. Google's CORS headers let the
// extension call the API without a host permission.
import { StoreError, statusOf, type Fetched, type ProbeResult, type Store, type StoreConnection, type StoreFailure, type StoreStatus } from './ports.ts';
import { DEVICES_PREFIX, STORE_NAME } from './store-format.ts';
import { slots } from './local.ts';
import type { Chosen } from './stores.ts';
import type { Fetch } from './webdav-store.ts';

/**
 * The OAuth client every Synclium build signs in through: a Google Cloud "Web application" client whose
 * authorized redirect URIs list `https://<extension id>.chromiumapp.org/` for each id this build runs under.
 * Empty in a build without one, and setup then says Google Drive is unavailable.
 */
export const GOOGLE_CLIENT_ID = '';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';
const TOKEN_KEY = 'drive:token';
/** A token this close to expiry is renewed before use, so a request never carries one that lapses in flight. */
const EARLY_MS = 60_000;

export type DriveConfig = {
  /** The Helium Sync folder's Drive file id. */
  readonly folder: string;
  /** The Google account's address: the label, and the login hint so a silent renewal picks the same account. */
  readonly account: string;
};

/** An access token. `stale` is one Drive just refused, so a cached copy equal to it is never handed back. */
export type Auth = (stale: string | null) => Promise<string>;

type Held = { readonly token: string; readonly expires: number };

const isHeld = (value: unknown): value is Held =>
  typeof value === 'object' && value !== null && 'token' in value && typeof value.token === 'string' && 'expires' in value && typeof value.expires === 'number';

/**
 * Runs Google's token flow. Interactive shows the sign-in window and resolves null when the user closes it;
 * silent resolves null when Google wants a click. Either way a token is saved for the worker and the pages.
 */
async function signIn(interactive: boolean, account: string | null): Promise<string | null> {
  if (GOOGLE_CLIENT_ID === '') throw new Error('Google Drive is not available in this build');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: chrome.identity.getRedirectURL(),
    response_type: 'token',
    scope: SCOPE,
    prompt: interactive ? 'select_account' : 'none',
    ...(account === null ? {} : { login_hint: account }),
  }).toString();
  let redirect: string | undefined;
  try {
    // Google's prompt=none answers through a script redirect, so a silent flow waits for it instead of aborting on load.
    redirect = await chrome.identity.launchWebAuthFlow({ url: url.href, interactive, abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: 10_000 });
  } catch {
    return null; // the window was closed, or a silent flow needed a click
  }
  const answer = new URLSearchParams(new URL(redirect ?? 'about:blank').hash.slice(1));
  const token = answer.get('access_token');
  if (token === null) return null; // error=interaction_required, access_denied, …
  const held: Held = { token, expires: Date.now() + Number(answer.get('expires_in') ?? 3600) * 1000 };
  await chrome.storage.session.set({ [TOKEN_KEY]: held });
  return token;
}

/** The worker's and the pages' Auth: the saved token while it is good, else a silent renewal, else needs-permission. */
export function driveAuth(account: string | null): Auth {
  return async (stale) => {
    const held: unknown = (await chrome.storage.session.get(TOKEN_KEY))[TOKEN_KEY];
    if (isHeld(held) && held.token !== stale && held.expires - EARLY_MS > Date.now()) return held.token;
    const token = await signIn(false, account);
    if (token === null) throw new StoreError({ kind: 'needs-permission' });
    return token;
  };
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Drive's errors in the popup's words. 403 covers both a full Drive and rate limiting, told apart by `reason`. */
async function failureOf(res: Response): Promise<StoreFailure> {
  const body = await res.text().catch(() => '');
  if (res.status === 401) return { kind: 'needs-permission' };
  if (res.status === 429 || /rateLimitExceeded/i.test(body)) return { kind: 'unreachable', detail: 'Google Drive asked to slow down' };
  if (res.status >= 500) return { kind: 'unreachable', detail: `Google Drive error ${res.status}` };
  if (/storageQuotaExceeded/.test(body)) return { kind: 'rejected', detail: 'your Google Drive is full' };
  if (res.status === 403) return { kind: 'rejected', detail: 'access denied' };
  return { kind: 'rejected', detail: `HTTP ${res.status}` };
}

type Entry = { readonly id: string; readonly name: string; readonly md5Checksum: string | null };
type Page = { readonly files: readonly Entry[]; readonly next: string | null };

const isEntry = (v: unknown): v is { id: string; name: string } =>
  typeof v === 'object' && v !== null && 'id' in v && typeof v.id === 'string' && 'name' in v && typeof v.name === 'string';

function pageOf(body: unknown): Page {
  if (typeof body !== 'object' || body === null || !('files' in body) || !Array.isArray(body.files)) return { files: [], next: null };
  const files = body.files.filter(isEntry).map((f) => ({ id: f.id, name: f.name, md5Checksum: 'md5Checksum' in f && typeof f.md5Checksum === 'string' ? f.md5Checksum : null }));
  const next = 'nextPageToken' in body && typeof body.nextPageToken === 'string' ? body.nextPageToken : null;
  return { files, next };
}

/** A string literal inside a Drive query. */
const quoted = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** The raw API with a token. Every method rejects only with StoreError. */
function drive(auth: Auth, fetchFn: Fetch) {
  let token: string | null = null;

  async function once(url: string, init: RequestInit): Promise<Response> {
    token ??= await auth(null);
    try {
      return await fetchFn(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` }, credentials: 'omit', cache: 'no-store' });
    } catch (error) {
      throw new StoreError({ kind: 'unreachable', detail: messageOf(error) });
    }
  }

  /** A 401 renews the token once, for a token that lapsed early or was revoked and granted again. */
  async function send(url: string, init: RequestInit = {}): Promise<Response> {
    const first = await once(url, init);
    if (first.status !== 401) return first;
    await first.body?.cancel();
    token = await auth(token);
    return once(url, init);
  }

  /** `res` when its status is one of `ok` (any 2xx when none); otherwise its failure as a StoreError. */
  async function expect(res: Response, ...ok: readonly number[]): Promise<Response> {
    if (ok.includes(res.status) || (ok.length === 0 && res.ok)) return res;
    throw new StoreError(await failureOf(res));
  }

  /** Every entry matching `q`, oldest first for folders, newest first for files. */
  async function query(q: string, orderBy: string): Promise<readonly Entry[]> {
    const found: Entry[] = [];
    let next: string | null = null;
    do {
      const params = new URLSearchParams({ q, orderBy, pageSize: '1000', fields: 'nextPageToken,files(id,name,md5Checksum)', ...(next === null ? {} : { pageToken: next }) });
      const page = pageOf(await (await expect(await send(`${API}/files?${params}`), 200)).json());
      found.push(...page.files);
      next = page.next;
    } while (next !== null);
    return found;
  }

  async function child(parent: string, name: string, folder: boolean): Promise<Entry | null> {
    const q = `${quoted(parent)} in parents and name = ${quoted(name)} and trashed = false and mimeType ${folder ? '=' : '!='} '${FOLDER}'`;
    return (await query(q, folder ? 'createdTime' : 'modifiedTime desc'))[0] ?? null;
  }

  async function children(parent: string): Promise<readonly Entry[]> {
    return query(`${quoted(parent)} in parents and trashed = false`, 'name');
  }

  async function createFolder(parent: string, name: string): Promise<string> {
    const res = await send(`${API}/files?fields=id,name`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }),
    });
    const body: unknown = await (await expect(res, 200)).json();
    if (!isEntry(body)) throw new StoreError({ kind: 'rejected', detail: 'Google Drive sent an unexpected answer' });
    return body.id;
  }

  /** 404 and 410 both mean gone. */
  async function remove(id: string): Promise<void> {
    const res = await send(`${API}/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (res.status === 404 || res.status === 410) return void (await res.body?.cancel());
    await expect(res);
  }

  return { send, expect, query, child, children, createFolder, remove };
}

/** `a/b/c.x` -> ['a/b/', 'c.x']; a key at the root has dir ''. */
function split(key: string): readonly [string, string] {
  const slash = key.lastIndexOf('/');
  return [key.slice(0, slash + 1), key.slice(slash + 1)];
}

/** The folders `key` sits in, shallowest first: `a/b/c.x` -> `a/`, `a/b/`. */
function parentsOf(key: string): readonly string[] {
  const segments = key.split('/').slice(0, -1);
  return segments.map((_, i) => `${segments.slice(0, i + 1).join('/')}/`);
}

/**
 * Store over the Helium Sync folder in Drive. A file's version is its md5, so an unchanged peer costs one query
 * and no download.
 */
export function driveStore(config: DriveConfig, auth: Auth, fetchFn: Fetch = fetch): Store {
  const api = drive(auth, fetchFn);
  /** Folder path ('' or ending in '/') -> id. Only this device deletes its folders, and it forgets them here. */
  const dirs = new Map<string, string>([['', config.folder]]);

  /** Trashed or deleted. Children of a trashed folder read as absent, so this tells "gone" from "not there". */
  async function rootGone(): Promise<boolean> {
    const res = await api.send(`${API}/files/${encodeURIComponent(config.folder)}?fields=trashed`);
    if (res.status === 404) return true;
    const body: unknown = await (await api.expect(res, 200)).json();
    return typeof body === 'object' && body !== null && 'trashed' in body && body.trashed === true;
  }

  /** An absent entry is just absent, unless the store itself is gone, which is missing (never an empty store). */
  async function absent<T>(value: T): Promise<T> {
    if (await rootGone()) throw new StoreError({ kind: 'missing' });
    return value;
  }

  /** Never recreates inside a store the user trashed. */
  async function creatable(): Promise<void> {
    if (await rootGone()) throw new StoreError({ kind: 'missing' });
  }

  async function dirId(path: string, create: boolean): Promise<string | null> {
    const known = dirs.get(path);
    if (known !== undefined) return known;
    let parent = config.folder;
    for (const dir of parentsOf(path)) {
      const cached = dirs.get(dir);
      if (cached !== undefined) {
        parent = cached;
        continue;
      }
      const name = split(dir.slice(0, -1))[1];
      let id = (await api.child(parent, name, true))?.id ?? null;
      if (id === null) {
        if (!create) return null;
        await creatable();
        id = await api.createFolder(parent, name);
      }
      dirs.set(dir, id);
      parent = id;
    }
    return parent;
  }

  async function find(key: string): Promise<Entry | null> {
    const [dir, name] = split(key);
    const parent = await dirId(dir, false);
    return parent === null ? null : api.child(parent, name, false);
  }

  async function put(key: string, bytes: Uint8Array): Promise<void> {
    const body = bytes.slice(); // an ArrayBuffer-backed copy, which BodyInit and BlobPart take
    const [dir, name] = split(key);
    const parent = await dirId(dir, true);
    if (parent === null) throw new Error('unreachable: dirId creates');
    const existing = await api.child(parent, name, false);
    if (existing !== null) {
      const res = await api.send(`${UPLOAD}/files/${encodeURIComponent(existing.id)}?uploadType=media&fields=id`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/octet-stream' },
        body,
      });
      if (res.status !== 404) return void (await api.expect(res, 200));
      await res.body?.cancel(); // deleted since the lookup: create it
    }
    await creatable();
    const boundary = `synclium-${crypto.randomUUID()}`;
    const meta = JSON.stringify({ name, parents: [parent] });
    const multipart = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
      `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
      body,
      `\r\n--${boundary}--`,
    ]);
    const res = await api.send(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: multipart,
    });
    await api.expect(res, 200);
  }

  async function get(key: string, known: string | null): Promise<Fetched> {
    const entry = await find(key);
    if (entry === null) return absent({ kind: 'missing' });
    const version = entry.md5Checksum ?? entry.id;
    if (version === known) return { kind: 'unchanged' };
    const res = await api.send(`${API}/files/${encodeURIComponent(entry.id)}?alt=media`);
    if (res.status === 404) {
      await res.body?.cancel();
      return absent({ kind: 'missing' });
    }
    return { kind: 'ok', bytes: new Uint8Array(await (await api.expect(res, 200)).arrayBuffer()), version };
  }

  async function del(key: string): Promise<void> {
    const entry = await find(key);
    if (entry === null) return absent(undefined);
    await api.remove(entry.id);
  }

  return {
    async list(prefix) {
      const id = await dirId(prefix, false);
      if (id === null) return absent([]);
      return [...new Set((await api.children(id)).map((e) => e.name))].sort();
    },
    get,
    put,
    async delete(key) {
      await del(key);
      // Remove the folders the delete emptied, deepest first. devices/ itself stays: it marks a store.
      for (const dir of parentsOf(key).filter((d) => d !== DEVICES_PREFIX).reverse()) {
        const id = await dirId(dir, false);
        if (id === null) continue;
        if ((await api.children(id)).length > 0) return;
        await api.remove(id);
        dirs.delete(dir);
      }
    },
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

/**
 * The Helium Sync folder this app made, wherever the user moved it in their Drive, or a new one in My Drive,
 * with its devices/ so the next device recognizes it. The oldest wins, so devices that raced agree.
 */
export async function driveRootIn(auth: Auth, fetchFn: Fetch = fetch): Promise<string> {
  const api = drive(auth, fetchFn);
  const DEVICES = DEVICES_PREFIX.slice(0, -1);
  const found = await api.query(`name = ${quoted(STORE_NAME)} and mimeType = '${FOLDER}' and trashed = false`, 'createdTime');
  const folder = found[0]?.id ?? (await api.createFolder('root', STORE_NAME));
  if ((await api.child(folder, DEVICES, true)) === null) await api.createFolder(folder, DEVICES);
  return folder;
}

/** The signed-in account's address. */
export async function driveAccount(auth: Auth, fetchFn: Fetch = fetch): Promise<string> {
  const api = drive(auth, fetchFn);
  const body: unknown = await (await api.expect(await api.send(`${API}/about?fields=user(emailAddress)`), 200)).json();
  const user = typeof body === 'object' && body !== null && 'user' in body ? body.user : null;
  return typeof user === 'object' && user !== null && 'emailAddress' in user && typeof user.emailAddress === 'string' ? user.emailAddress : 'Google account';
}

/** "Google Drive (you@gmail.com)", for the popup's sentences. */
export const labelOf = (config: DriveConfig): string => `Google Drive (${config.account})`;

/** Never prompts and never touches the network: a lapsed sign-in shows as needs-permission on the first request. */
export function connectDrive(config: DriveConfig, fetchFn: Fetch = fetch): StoreConnection {
  return { access: 'ready', label: labelOf(config), store: driveStore(config, driveAuth(config.account), fetchFn) };
}

/** App page, inside a click, for app.html#allow: the Google sign-in window for the same account. */
export async function allowDrive(config: DriveConfig): Promise<StoreStatus> {
  const token = await signIn(true, config.account);
  return token === null ? { access: 'failed', label: labelOf(config), why: { kind: 'needs-permission' } } : statusOf(connectDrive(config));
}

/**
 * App page, inside the Connect click: Google's sign-in window first, then find or create the folder, then probe.
 * Saved as `candidate` only when the probe passed, as a picked folder is.
 */
export async function chooseDrive(): Promise<Chosen> {
  if ((await signIn(true, null)) === null) return { kind: 'cancelled' };
  const auth = driveAuth(null);
  let config: DriveConfig;
  try {
    config = { account: await driveAccount(auth), folder: await driveRootIn(auth) };
  } catch (error) {
    if (!(error instanceof StoreError)) throw error;
    return { kind: 'chosen', label: 'Google Drive', probe: { kind: 'failed', why: error.why } };
  }
  const probe = await driveStore(config, auth).probe();
  if (probe.kind === 'ok') await slots.putCandidate({ kind: 'drive', config });
  return { kind: 'chosen', label: labelOf(config), probe };
}
