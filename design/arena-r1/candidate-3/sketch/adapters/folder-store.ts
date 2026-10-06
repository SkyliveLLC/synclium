// Store over a directory the user already syncs. Folder-specific hazards live here and nowhere else.
import type { Store } from "../ports.ts";

/**
 * - put: write `.tmp-<rand>` in the same dir then rename (atomic to local readers; Syncthing/Dropbox
 *   upload whole files after rename). Temp names are ignored by keys.parse on the reading side.
 * - get: if a file is an unmaterialised iCloud placeholder (`.<name>.icloud`), request download and
 *   return null ("not yet"); the next cycle picks it up.
 * - list: skips anything keys.parse rejects, but counts "(conflicted copy)" files for a warning.
 * - watch: fs.watch recursive + debounce 500ms (cloud clients touch files in bursts).
 */
export function folderStore(_root: string): Store {
  throw new Error("not implemented");
}
