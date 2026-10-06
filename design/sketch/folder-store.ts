// The v1 store: a folder the user already syncs, reached through the File System Access API. Every folder and
// permission hazard lives here. FileSystemHandle types appear nowhere else except local.ts's kv schema.
//
// Contexts. `chooseFolder` and `allowFolder` need a user gesture, so they run only in the app page (a tab: the
// native picker steals focus and closes a popup mid-promise). `connectFolder` runs in the worker. That last
// claim is UNVERIFIED (P7); DESIGN.md's ladder names the fallback for each way it can fail.
//
// Two handle slots, one writer each. The app page writes `candidate` when the user picks a folder. The worker
// promotes it to `current` on Start, under the cycle lock. Picking a folder and backing out changes nothing.
import type { ProbeResult, Store, StoreConnection, StoreStatus } from './ports.ts';
import { handles } from './local.ts';

export type HandleSlot = 'current' | 'candidate';

export type ChosenFolder = {
  /** handle.name only. File System Access never reveals a path, so the UI never shows one. */
  readonly label: string;
  readonly probe: ProbeResult;
};

/**
 * App page only, inside a click handler. showDirectoryPicker({ id: 'helium-sync', mode: 'readwrite' }) shows
 * the native picker, then Chromium's "Let Helium Sync edit files?" prompt. The user may pick the store or the
 * folder that holds it:
 *   picked has devices/                 -> the store is the picked folder
 *   picked has "Helium Sync/devices/"   -> the store is that child (device 2 picks "iCloud Drive" like device 1)
 *   otherwise                           -> create "Helium Sync/" inside the picked folder
 * Saves the store handle as `candidate` and probes it. The page then asks the worker for a preview.
 */
export async function chooseFolder(): Promise<ChosenFolder> {
  throw new Error('not implemented');
}

/**
 * Any context, never prompts. queryPermission({ mode: 'readwrite' }) on the slot's handle.
 *   no handle                    -> not-set-up
 *   'granted' and root readable  -> ready, with folderStore(handle)
 *   'prompt'                     -> failed needs-permission
 *   NotFoundError                -> failed missing
 */
export async function connectFolder(slot: HandleSlot): Promise<StoreConnection> {
  const handle = await handles.get(slot);
  if (handle === undefined) return { access: 'not-set-up' };
  throw new Error('not implemented');
}

/**
 * App page, inside a click handler. requestPermission({ mode: 'readwrite' }) on `current`. If Chromium offers
 * "Allow on every visit" and the user takes it, this should be the last time they see it (P7 rung B).
 */
export async function allowFolder(): Promise<StoreStatus> {
  throw new Error('not implemented');
}

/** Worker, under the cycle lock, on Start. `candidate` becomes `current`. */
export async function promoteCandidate(): Promise<void> {
  throw new Error('not implemented');
}

/**
 * Store over a directory handle. Keys map to nested directories.
 *  - get:    getFile(); version = `${lastModified}:${size}`; equal to `known` -> unchanged without reading bytes.
 *            NotFoundError, or only an iCloud placeholder `.<name>.icloud` -> missing ("not yet").
 *  - put:    getFileHandle({ create: true }), createWritable(), write, close(). Chromium writes a `.crswap`
 *            sibling and renames on close, so readers usually see old or new bytes. The manifest hash covers
 *            the cases where a cloud client syncs a half-written file anyway.
 *  - list:   one directory's entry names. `.crswap`, `.DS_Store`, and conflict copies come back as names and
 *            the engine reports them as foreign.
 *  - delete: removeEntry; NotFoundError is success; then remove parents left empty.
 *  - probe:  write, read back, and remove `.helium-sync-probe` at the store root.
 * NotAllowedError mid-cycle -> StoreError needs-permission. NotFoundError on the root -> StoreError missing.
 */
export function folderStore(_root: FileSystemDirectoryHandle): Store {
  throw new Error('not implemented');
}
