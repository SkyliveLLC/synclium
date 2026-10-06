// The four seams. The engine imports only these, never node:fs or Chromium specifics.
import type { ChangeOf, LocalOf, MergedIds, Registry } from "./registry.ts";
import type { ProfileId, StoreKey } from "./ids.ts";

/**
 * Transport: a dumb blob store. Folder today; S3/WebDAV/hosted server later.
 * Contract a transport must meet (and nothing more):
 *  - put() is atomic to readers (old or new bytes, never torn). Folder impl: temp file + rename.
 *  - No CAS, locking, ordering or listing consistency. The engine never relies on them:
 *    each key has exactly one writer (see envelope.ts `keys`), and a failed/partial read is "not yet".
 *  - Bytes are opaque ciphertext. A Store never sees plaintext or keys.
 */
export interface Store {
  list(prefix: string): Promise<readonly StoreEntry[]>;
  get(key: StoreKey): Promise<Uint8Array | null>;
  put(key: StoreKey, bytes: Uint8Array): Promise<void>;
  delete(key: StoreKey): Promise<void>;
  /** Optional push notification (fs.watch for folders). Without it, frontends poll. */
  watch?(prefix: string, onChange: () => void): { close(): void };
}
export interface StoreEntry { key: StoreKey; size: number; modified: number }

/**
 * Browser side. `open()` decides once per sync what is possible *right now*, so engine code
 * never branches on "extension vs file".
 */
export interface Profile<R extends Registry> {
  readonly id: ProfileId;
  open(): Promise<ProfileSession<R>>;
}
export interface ProfileSession<R extends Registry> {
  /**
   *  live      - browser running, extension connected: read and write
   *  offline   - browser closed, direct file access: read and write
   *  read-only - browser running, no extension: publish local changes, defer applying remote ones
   */
  readonly mode: "live" | "offline" | "read-only";
  readonly note?: string; // e.g. "Close Helium to apply 12 pending changes"
  /** Absent channel = this session cannot touch that type (reported, not an error). */
  channel<K extends keyof R & string>(type: K): Channel<LocalOf<R[K]>, ChangeOf<R[K]>> | undefined;
  close(): Promise<void>;
}
export interface Channel<Local, Change> {
  read(): Promise<Local>;
  /**
   * Make the profile equal `target`. Adapters pick what they need: the file adapter rewrites from
   * `target`, the extension adapter replays `changes`. Must be safe to re-run after a crash, and must
   * return "deferred" (not throw) if the world changed underneath (browser started mid-write).
   * Observed types have no apply.
   */
  apply?(input: { current: Local; target: Local; changes: readonly Change[] }): Promise<"applied" | "deferred">;
}
export type MergedChannel<R extends Registry, K extends MergedIds<R>> = Channel<LocalOf<R[K]>, ChangeOf<R[K]>>;

/**
 * Device-private state (never synced): last applied view per type, HLC, highest seq seen per device
 * (rollback detection), id aliases, last-good copy of each remote file, backups. Directory-shaped
 * so a desktop app can relocate it. `lock` makes two engines (CLI + extension host) on one device
 * serialize; the sync cycle runs under it.
 */
export interface LocalState {
  get(name: string): Promise<unknown | null>;
  put(name: string, json: unknown): Promise<void>;
  lock<T>(fn: () => Promise<T>): Promise<T>;
}

/** Holds the vault key and device private key. Default: 0600 file; macOS: `security` keychain CLI. */
export interface SecretStore {
  get(name: string): Promise<Uint8Array | null>;
  set(name: string, value: Uint8Array): Promise<void>;
  delete(name: string): Promise<void>;
}

export interface Clock { now(): number }
