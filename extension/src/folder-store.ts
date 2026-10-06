// The v1 store: a folder the user already syncs (iCloud Drive, Dropbox, Syncthing), reached through the File
// System Access API. Every folder and permission hazard lives here, and DOMExceptions become StoreFailures at
// this boundary only.
//
// Contexts, as observed in P7 on Helium 154:
//   chooseFolder, allowFolder  app page, inside a click. The picker and the permission prompt need a gesture
//                              and take focus, which would close the popup mid-promise.
//   connectFolder, the Store   any context, the service worker included. Never prompts.
// The picker's grant lapses at the first browser restart: queryPermission reads `prompt` and every call throws
// NotAllowedError (P7 rung B). The worker then reports needs-permission and keeps running local-only cycles until
// the user clicks Allow access in app.html#allow. That requestPermission prompt offers "Allow on every visit",
// which P7 saw hold across later restarts; the picker's own prompt does not, so setup never pre-requests.
//
// Two handle slots, one writer each (local.ts). The page writes `candidate` when the user picks a folder; the
// worker promotes it to `current` on Start, under the cycle lock. Picking a folder and backing out changes nothing.
import { StoreError, type Fetched, type ProbeResult, type Store, type StoreConnection, type StoreFailure, type StoreStatus } from './ports.ts';
import { DEVICES_PREFIX, type StoreKey } from './store-format.ts';
import { handles, type HandleSlot } from './local.ts';
import type { StoreBackend } from './background.ts';

/** The folder setup creates when the picked one is not already a store. */
export const STORE_NAME = 'Helium Sync';
const DEVICES = DEVICES_PREFIX.slice(0, -1);
const PROBE = '.helium-sync-probe';
const READWRITE = { mode: 'readwrite' } as const;

/**
 * The slice of FileSystemDirectoryHandle this module uses. A real handle satisfies it structurally, and so does
 * the in-memory fake the tests run against. `this` keeps a picked handle's own type through storeRootIn, so the
 * root it returns can go back into IndexedDB.
 */
export interface Dir {
  readonly name: string;
  queryPermission(descriptor: typeof READWRITE): Promise<PermissionState>;
  requestPermission(descriptor: typeof READWRITE): Promise<PermissionState>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<this>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandle>;
  removeEntry(name: string): Promise<void>;
  keys(): AsyncIterable<string>;
}

export interface FileHandle {
  getFile(): Promise<{ readonly lastModified: number; readonly size: number; arrayBuffer(): Promise<ArrayBuffer> }>;
  /** Chromium writes a `<name>.crswap` sibling and renames it over the file on close, so close is the atomic swap. */
  createWritable(): Promise<{ write(data: Uint8Array<ArrayBuffer>): Promise<void>; close(): Promise<void>; abort(): Promise<void> }>;
}

const MISSING: Fetched = { kind: 'missing' };

const nameIs = (error: unknown, name: string): boolean => error instanceof DOMException && error.name === name;

/** The one DOMException-to-StoreFailure table. Anything that is not a DOMException is a bug and propagates. */
export function failureFrom(error: unknown): StoreFailure {
  if (!(error instanceof DOMException)) throw error;
  switch (error.name) {
    case 'NotAllowedError':
      return { kind: 'needs-permission' };
    case 'NotFoundError':
      return { kind: 'missing' };
    default:
      return { kind: 'rejected', detail: `${error.name}: ${error.message}` };
  }
}

/** Runs one Store call so that it rejects only with StoreError, as the port requires. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new StoreError(failureFrom(error));
  }
}

/** Rejects with NotFoundError when the folder itself was moved or deleted. */
async function isEmpty(dir: Dir): Promise<boolean> {
  for await (const _ of dir.keys()) return false;
  return true;
}

/** A NotFoundError below the root means the entry is absent, unless the root itself is gone. */
async function absent<T>(root: Dir, error: unknown, value: T): Promise<T> {
  if (!nameIs(error, 'NotFoundError')) throw error;
  await isEmpty(root);
  return value;
}

const segments = (path: string): readonly string[] => path.split('/').filter((s) => s !== '');

async function dirAt(root: Dir, path: readonly string[], create: boolean): Promise<Dir> {
  let dir = root;
  for (const name of path) dir = await dir.getDirectoryHandle(name, { create });
  return dir;
}

function splitKey(key: StoreKey): { readonly dirs: readonly string[]; readonly name: string } {
  const slash = key.lastIndexOf('/');
  return { dirs: segments(key.slice(0, slash + 1)), name: key.slice(slash + 1) };
}

async function writeAll(file: FileHandle, bytes: Uint8Array): Promise<void> {
  const out = await file.createWritable();
  try {
    await out.write(bytes.slice()); // `write` takes an ArrayBuffer-backed view; slice() copies into one
  } catch (error) {
    await out.abort().catch(() => {}); // drops the .crswap; the write error is the one worth reporting
    throw error;
  }
  await out.close();
}

const bytesOf = async (file: FileHandle): Promise<Uint8Array> => new Uint8Array(await (await file.getFile()).arrayBuffer());

/** Removes `name` under `path`, then each folder on `path` the removal left empty, deepest first. */
async function removeAt(dir: Dir, path: readonly string[], name: string, depth = 0): Promise<void> {
  const [head, ...rest] = path;
  if (head === undefined) return dir.removeEntry(name);
  const child = await dir.getDirectoryHandle(head);
  await removeAt(child, rest, name, depth + 1);
  // devices/ itself stays: it is how storeRootIn recognizes a store.
  if (depth === 0 || !(await isEmpty(child))) return;
  await dir.removeEntry(head).catch((error: unknown) => {
    if (!nameIs(error, 'InvalidModificationError')) throw error; // a sync client put something there meanwhile
  });
}

/**
 * Store over a directory handle. Keys map to nested folders. A file's version is `lastModified:size`, which P7
 * observed changing on a same-size rewrite two seconds apart.
 */
export function folderStore(root: Dir): Store {
  return {
    list: (prefix) =>
      guarded(async () => {
        let dir: Dir;
        try {
          dir = await dirAt(root, segments(prefix), false);
        } catch (error) {
          return absent(root, error, []);
        }
        // Foreign names (.crswap leftovers, .DS_Store, conflict copies) come back too; the engine reports them.
        const names: string[] = [];
        for await (const name of dir.keys()) names.push(name);
        return names.sort();
      }),
    get: (key, known) =>
      guarded(async (): Promise<Fetched> => {
        const { dirs, name } = splitKey(key);
        try {
          const file = await (await dirAt(root, dirs, false)).getFileHandle(name);
          const meta = await file.getFile();
          const version = `${meta.lastModified}:${meta.size}`;
          if (version === known) return { kind: 'unchanged' };
          return { kind: 'ok', bytes: new Uint8Array(await meta.arrayBuffer()), version };
        } catch (error) {
          // The file changed between the metadata read and the byte read: not yet, like a placeholder.
          if (nameIs(error, 'NotReadableError')) return MISSING;
          return absent(root, error, MISSING);
        }
      }),
    put: (key, bytes) =>
      guarded(async () => {
        const { dirs, name } = splitKey(key);
        await writeAll(await (await dirAt(root, dirs, true)).getFileHandle(name, { create: true }), bytes);
      }),
    delete: (key) =>
      guarded(async () => {
        const { dirs, name } = splitKey(key);
        try {
          await removeAt(root, dirs, name);
        } catch (error) {
          await absent(root, error, undefined);
        }
      }),
    async probe(): Promise<ProbeResult> {
      try {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        const file = await root.getFileHandle(PROBE, { create: true });
        await writeAll(file, bytes);
        const back = await bytesOf(file);
        await root.removeEntry(PROBE);
        const same = back.length === bytes.length && back.every((b, i) => b === bytes[i]);
        return same ? { kind: 'ok' } : { kind: 'failed', why: { kind: 'rejected', detail: 'the probe file read back different bytes' } };
      } catch (error) {
        return { kind: 'failed', why: failureFrom(error) };
      }
    },
  };
}

/** Never prompts. A Store comes back only when the grant reads `granted` and the folder still exists. */
export async function connectRoot(root: Dir | undefined): Promise<StoreConnection> {
  if (root === undefined) return { access: 'not-set-up' };
  const label = root.name;
  try {
    if ((await root.queryPermission(READWRITE)) !== 'granted') return { access: 'failed', label, why: { kind: 'needs-permission' } };
    await isEmpty(root); // a moved or deleted folder throws NotFoundError here
    return { access: 'ready', label, store: folderStore(root) };
  } catch (error) {
    return { access: 'failed', label, why: failureFrom(error) };
  }
}

const statusOf = (conn: StoreConnection): StoreStatus => (conn.access === 'ready' ? { access: 'ready', label: conn.label } : conn);

/** Inside a click. Shows Chromium's re-grant prompt when the grant lapsed; a live grant answers without one. */
export async function allowRoot(root: Dir | undefined): Promise<StoreStatus> {
  if (root !== undefined) await root.requestPermission(READWRITE);
  return statusOf(await connectRoot(root));
}

async function childDir<D extends Dir>(dir: D, name: string): Promise<D | null> {
  try {
    return await dir.getDirectoryHandle(name);
  } catch (error) {
    if (nameIs(error, 'NotFoundError') || nameIs(error, 'TypeMismatchError')) return null;
    throw error;
  }
}

/**
 * The store inside a picked folder. Device 2 may pick the store itself or the folder that holds it:
 *   picked has devices/               -> the picked folder
 *   picked has "Helium Sync/devices/" -> that child
 *   otherwise                         -> "Helium Sync/" inside the picked folder, created with its devices/
 */
export async function storeRootIn<D extends Dir>(picked: D): Promise<D> {
  if ((await childDir(picked, DEVICES)) !== null) return picked;
  const child = await childDir(picked, STORE_NAME);
  if (child !== null && (await childDir(child, DEVICES)) !== null) return child;
  const created = await picked.getDirectoryHandle(STORE_NAME, { create: true });
  await created.getDirectoryHandle(DEVICES, { create: true });
  return created;
}

// ---------- Shells over IndexedDB and the picker ----------

export const connectFolder = async (slot: HandleSlot): Promise<StoreConnection> => connectRoot(await handles.get(slot));

/** What the worker runs on. */
export const folderBackend: StoreBackend = { connect: connectFolder, promote: handles.promote };

export type Chosen =
  | { readonly kind: 'cancelled' }
  /** Saved as `candidate` only when the probe passed, so a folder that cannot be written never reaches Start. */
  | { readonly kind: 'chosen'; readonly label: string; readonly probe: ProbeResult };

/** App page, inside a click: the native picker, then Chromium's "Allow this site to edit files?" prompt. */
export async function chooseFolder(): Promise<Chosen> {
  let picked: FileSystemDirectoryHandle;
  try {
    picked = await window.showDirectoryPicker({ id: 'helium-sync', mode: 'readwrite' });
  } catch (error) {
    if (nameIs(error, 'AbortError')) return { kind: 'cancelled' };
    throw error;
  }
  let root: FileSystemDirectoryHandle;
  try {
    root = await storeRootIn(picked);
  } catch (error) {
    return { kind: 'chosen', label: picked.name, probe: { kind: 'failed', why: failureFrom(error) } };
  }
  const probe = await folderStore(root).probe();
  if (probe.kind === 'ok') await handles.putCandidate(root);
  return { kind: 'chosen', label: root.name, probe };
}

/** App page, inside a click, for app.html#allow. */
export const allowFolder = async (): Promise<StoreStatus> => allowRoot(await handles.get('current'));
