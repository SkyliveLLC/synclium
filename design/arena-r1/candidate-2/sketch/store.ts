// Transport boundary. Bytes in, bytes out. A new transport (S3, WebDAV, hosted server) implements these four
// methods and never learns the schema. `watch` is optional: folders have it, object stores poll.

export type StoreEntry = { readonly path: string; readonly size: number };

export interface Store {
  /** Entries whose path starts with `prefix`. Paths are `/`-separated and relative to the store root. */
  list(prefix: string): Promise<readonly StoreEntry[]>;
  read(path: string): Promise<Uint8Array | null>;
  /** Atomic replace: readers see the old bytes or the new bytes, never a partial file. */
  write(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  /** Fires on any change under the root, debounced by the implementation. Returns an unsubscribe. */
  watch?(onChange: () => void): () => void;
}

/**
 * A folder the user already syncs (iCloud Drive, Dropbox, Syncthing).
 * - write = temp file in the same directory + rename.
 * - read handles iCloud eviction: a `.name.icloud` placeholder triggers `brctl download` and waits (bounded).
 * - list ignores conflict copies ("name (conflicted copy).json", "name.sync-conflict-…") and dotfiles; those can
 *   only exist if two devices wrote the same path, which the layout forbids, so they are reported, not merged.
 */
export class FolderStore implements Store {
  constructor(readonly root: string) {}
  list(prefix: string): Promise<readonly StoreEntry[]> {
    throw new Error('not implemented');
  }
  read(path: string): Promise<Uint8Array | null> {
    throw new Error('not implemented');
  }
  write(path: string, bytes: Uint8Array): Promise<void> {
    throw new Error('not implemented');
  }
  remove(path: string): Promise<void> {
    throw new Error('not implemented');
  }
  watch(onChange: () => void): () => void {
    // TODO fs.watch(root, { recursive: true }) debounced 3s; iCloud delivers changes as rename bursts.
    throw new Error('not implemented');
  }
}
