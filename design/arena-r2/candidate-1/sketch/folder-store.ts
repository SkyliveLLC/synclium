// The store: a folder the user already syncs, reached through the File System Access API. Every folder and
// permission hazard lives here. FileSystemHandle types appear nowhere else except local.ts's kv schema.
//
// Contexts: `chooseFolder` and `allowFolder` need a user gesture, so they run only in the app page (a tab,
// not the popup: the native picker steals focus and closes a popup mid-promise). `connectFolder` runs
// anywhere, the service worker included. That last claim is UNVERIFIED; DESIGN.md "Permission ladder" names
// the fallback for each way it can fail.
import type { DeviceMeta } from './store-format.ts';
import type { Store, StoreConnection, StoreStatus } from './ports.ts';
import { kv } from './local.ts';

/** IndexedDB key holding the store folder's FileSystemDirectoryHandle (structured-cloneable). */
const FOLDER_KEY = 'folder';

/** What setup shows before the user confirms: the folder name and the devices already in it. */
export type ChosenFolder = {
  /** handle.name only. File System Access never reveals a path, so the UI never shows one. */
  readonly folder: string;
  /** Empty: this device creates the store. Otherwise: it joins these devices. */
  readonly devices: readonly DeviceMeta[];
  /**
   * Under the local lock: save the handle and `local.reset(deviceName)` (a new DeviceId; a later "change
   * folder" joins the new store by adoption). Separate from picking so the user can back out after the preview.
   */
  confirm(deviceName: string): Promise<void>;
};

/**
 * App page only, inside a click handler. showDirectoryPicker({ id: 'helium-sync', mode: 'readwrite' })
 * shows the native picker, then Chromium's "Let Helium Sync edit files?" prompt.
 *
 * The user may pick the store itself or the folder that holds it:
 *   picked has devices/            -> the store is the picked folder
 *   picked has "Helium Sync/devices/" -> the store is that child (device 2 picks "iCloud Drive" like device 1 did)
 *   otherwise                      -> create "Helium Sync/" inside the picked folder
 * Chromium refuses some folders (home, ~/Library) but allows iCloud Drive (~/Library/Mobile Documents) and
 * ~/Library/CloudStorage (Dropbox, OneDrive). Unverified in Helium; a refusal shows Chromium's own dialog.
 */
export async function chooseFolder(): Promise<ChosenFolder> {
  throw new Error('not implemented');
}

/**
 * Any context. Loads the handle and asks queryPermission({ mode: 'readwrite' }); never prompts.
 *   no handle                    -> not-set-up
 *   'granted'                    -> ready, with a folderStore over the handle
 *   'prompt'                     -> needs-permission
 *   NotFoundError on first touch -> missing
 */
export async function connectFolder(): Promise<StoreConnection> {
  const handle = await kv.get(FOLDER_KEY);
  if (handle === undefined) return { access: 'not-set-up' };
  // TODO: queryPermission, then a cheap getDirectoryHandle('devices') to tell 'missing' from 'ready'.
  throw new Error('not implemented');
}

/**
 * App page or popup, inside a click handler. requestPermission({ mode: 'readwrite' }). If Chromium offers
 * "Allow on every visit" and the user takes it, the grant should survive restarts and this is the last
 * time they see it. Returns the new status; the caller then asks the worker to sync.
 */
export async function allowFolder(): Promise<StoreStatus> {
  throw new Error('not implemented');
}

/**
 * Store over a directory handle. Keys map to nested directories (`devices/<id>/history/<day>.hsync`).
 *  - put:    getFileHandle({ create: true }), createWritable(), write, close(). Chromium writes a `.crswap`
 *            sibling and renames it on close, so readers see old or new bytes, never torn ones.
 *  - get:    getFile().arrayBuffer(); NotFoundError -> null.
 *  - list:   recursive walk of `prefix`. version = `${lastModified}:${size}`. An iCloud placeholder
 *            `.<name>.icloud` is reported as `<name>` with downloaded: false, so a peer file iCloud evicted
 *            reads as "not yet" instead of "deleted".
 *  - delete: removeEntry; NotFoundError is success.
 * A NotAllowedError mid-cycle (permission revoked from site settings) throws; the engine reports the cycle
 * as local-only and the next connectFolder sees 'prompt'.
 */
function folderStore(_root: FileSystemDirectoryHandle): Store {
  throw new Error('not implemented');
}
