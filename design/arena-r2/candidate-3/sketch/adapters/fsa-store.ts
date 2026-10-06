// Store over a folder the user picked once (File System Access API). The folder is whatever they already
// sync: iCloud Drive, Dropbox, Syncthing. No account, no server, nothing of ours holds their data.
//
// Split by context, because the API is split:
//   page    showDirectoryPicker and requestPermission need a user gesture. They run only in setup.html.
//   worker  holds the handle (structured-cloned out of IndexedDB) and does every read and write. It can query
//           permission but never request it.
//
// UNVERIFIED GATE (grounding "still unverified"): whether the handle stays writable from the worker after a
// browser restart without a prompt. This design does not depend on the answer. When it lapses, `access()` returns
// `needs-access`, the cycle stops with `store` set, the badge shows "!", and the popup's one button opens the setup
// page, where `reconnect` is a single click. If the lapse is frequent, ship the WebDAV store (webdav-store.ts) as
// the default instead. Nothing above the Store port changes.
import type { Store } from '../ports.ts';

/** Database `helium-sync-handles`. Written by the setup page, read by the worker. */
export interface HandleVault {
  load(): Promise<FileSystemDirectoryHandle | null>;
  save(handle: FileSystemDirectoryHandle): Promise<void>;
}
export function idbHandleVault(): HandleVault {
  throw new Error('not implemented');
}

/** Page only. `showDirectoryPicker({ id: 'helium-sync', mode: 'readwrite' })`, then vault.save. Returns the folder name for the UI. */
export async function pickFolder(vault: HandleVault): Promise<string> {
  const handle = await window.showDirectoryPicker({ id: 'helium-sync', mode: 'readwrite', startIn: 'documents' });
  await vault.save(handle);
  return handle.name;
}

/** Page only, from a click. The one-tap fix for `needs-access`. */
export async function reconnect(vault: HandleVault): Promise<boolean> {
  const handle = await vault.load();
  return handle !== null && (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
}

export function fsaStore(vault: HandleVault): Store {
  return {
    async access() {
      const handle = await vault.load();
      if (handle === null) return { kind: 'unreachable', detail: 'no folder chosen' };
      const state = await handle.queryPermission({ mode: 'readwrite' });
      return state === 'granted' ? { kind: 'ok', label: handle.name } : { kind: 'needs-access', label: handle.name };
    },

    // list: walk `devices/` recursively, for each file `getFile()` gives size and lastModified (-> version).
    //       A folder that does not exist yet lists as empty. Names are store-relative with '/'.
    list: () => {
      throw new Error('not implemented');
    },

    // get: resolve nested dirs, getFile().arrayBuffer(). NotFoundError -> null. An iCloud placeholder
    //      (".<name>.icloud", or a file that throws on read while downloading) -> null, which means "not yet".
    get: () => {
      throw new Error('not implemented');
    },

    // put: getDirectoryHandle(create) down to the file, createWritable(), write, close(). The stream writes to a
    //      swap file and swaps on close, so readers (and the cloud client) see old bytes or new bytes. A worker
    //      killed before close() leaves the old file. parseKey ignores the `.crswap` leftover.
    put: () => {
      throw new Error('not implemented');
    },

    delete: () => {
      throw new Error('not implemented');
    },
  };
}
