// Store over a directory the user already syncs (iCloud Drive, Dropbox, Syncthing).
// Folder hazards live here and nowhere else.
import type { Brand } from '../model.ts';
import type { Store } from '../ports.ts';

/** Absolute, existing directory, not inside Helium's user-data dir. Minted only by `parseFolder`. */
export type FolderPath = Brand<string, 'FolderPath'>;

export function parseFolder(_input: string, _heliumUserDataDir: string): Promise<FolderPath> {
  throw new Error('not implemented');
}

/**
 * Keys live under `<root>/helium-sync/`.
 *  - put writes `.tmp-<rand>` in the same dir, fsyncs, renames. Cloud clients upload whole files after the rename.
 *  - get on an iCloud `.<name>.icloud` placeholder requests a download and returns null ("not yet").
 *  - list returns raw names. Conflict copies and temp files surface as foreign files in the report.
 *  - watch is fs.watch recursive, debounced 3 s, because cloud clients touch files in bursts.
 */
export function folderStore(_root: FolderPath): Store {
  throw new Error('not implemented');
}
