// The seams. The engine imports these and the pure modules, never node:* or Chromium shapes.
import type { DeviceId, HlcState, ItemId, Live, Rec, Replica } from './model.ts';
import type { RecordOf, Registry, TypeName } from './registry.ts';
import type { StateFile, StoreKey } from './store-format.ts';

// ---------- Store (transport) ----------

/**
 * A dumb blob store. A folder today. S3, WebDAV, or a hosted server later.
 * The whole contract:
 *  - `put` is atomic to readers (old bytes or new bytes, never torn).
 *  - One writer per key. The layout guarantees it, so no CAS, locking, or list consistency is needed.
 *  - `get` returning null means "not there yet" (missing, or an unmaterialised cloud placeholder).
 */
export interface Store {
  /** Raw names under `prefix`. The engine parses them, so foreign files cannot pass as keys. */
  list(prefix: string): Promise<readonly StoreEntry[]>;
  get(key: StoreKey): Promise<Uint8Array | null>;
  put(key: StoreKey, bytes: Uint8Array): Promise<void>;
  delete(key: StoreKey): Promise<void>;
  /** Optional change hint. Frontends also poll, because cloud folder events are unreliable. */
  watch?(onChange: () => void): { close(): void };
}
export type StoreEntry = { readonly name: string; readonly size: number };

// ---------- Profile (browser side) ----------

/**
 * `open` decides once per cycle what is possible right now. The engine never asks "file or extension?".
 *  - offline    Helium closed, file adapter. Read and write.
 *  - live       Helium running, extension connected (v2 adapter). Read and write.
 *  - read-only  Helium running, no extension. Publish local edits, defer remote ones.
 */
export interface Profile<Reg extends Registry> {
  open(): Promise<ProfileSession<Reg>>;
}

// `apply` exists only on a writable session's channels, so "write while Helium runs" does not compile.
export type ProfileSession<Reg extends Registry> =
  | {
      readonly mode: 'offline' | 'live';
      channel<K extends TypeName<Reg>>(type: K): WriteChannel<RecordOf<Reg[K]>>;
      close(): Promise<void>;
    }
  | {
      readonly mode: 'read-only';
      readonly why: ReadOnlyReason;
      channel<K extends TypeName<Reg>>(type: K): ReadChannel<RecordOf<Reg[K]>>;
      close(): Promise<void>;
    };
export type SessionMode = ProfileSession<Registry>['mode'];
export type ReadOnlyReason = { readonly kind: 'helium-running'; readonly pid: number };

export interface ReadChannel<R extends Rec> {
  /**
   * The profile's current content in domain terms, keyed by synced ids where the adapter knows them.
   * `previous` is the applied view. Adapters use it to keep derived values stable (bookmark positions).
   */
  read(previous: Live<R> | null): Promise<Live<R>>;
  /**
   * Local item `from` is synced item `to`. The adapter persists this until the profile carries `to`
   * natively (file adapter, next offline write rewrites the guid) or forever (live adapter, chrome ids).
   */
  bind(aliases: ReadonlyMap<ItemId, ItemId>): Promise<void>;
}

export interface WriteChannel<R extends Rec> extends ReadChannel<R> {
  /**
   * Make the profile equal `target`. Safe to re-run. Returns "deferred" instead of throwing when the
   * world changed underneath. The engine advances `applied` only on "applied", so "applied" must mean
   * the browser will show `target`, not merely that bytes hit the disk.
   */
  apply(change: { readonly current: Live<R>; readonly target: Live<R> }): Promise<ApplyResult>;
}
export type ApplyResult = { readonly kind: 'applied' } | { readonly kind: 'deferred'; readonly why: 'helium-started' };

// ---------- Device-private state ----------

/**
 * Never synced. One per installation. `lock` serialises engines on one machine (the daemon and a manual
 * `sync`). A stale lock (dead pid) is taken over.
 */
export interface LocalState<Reg extends Registry> {
  lock<T>(fn: () => Promise<T>): Promise<T>;
  /** Creates a fresh DeviceLocal with a new DeviceId on first call. */
  load(): Promise<DeviceLocal<Reg>>;
  /** Atomic replace. */
  save(next: DeviceLocal<Reg>): Promise<void>;
  /** New DeviceId, empty per-type state. For a device that was idle past the eviction window. */
  reset(): Promise<DeviceLocal<Reg>>;
}

export type DeviceLocal<Reg extends Registry> = {
  readonly device: DeviceId;
  readonly name: string;
  readonly clock: HlcState;
  /** Wall ms of our last meta.json write. Drives the heartbeat and the idle-self check. */
  readonly lastSeen: number | null;
  readonly types: { readonly [K in TypeName<Reg>]?: TypeLocal<RecordOf<Reg[K]>> };
};

export type TypeLocal<R extends Rec> = {
  /** Our replica as last committed. The source of our own state; the store copy is never read back as input. */
  readonly own: Replica<R>;
  readonly seq: number;
  /** Hash of the plaintext last confirmed in the store. `own` is committed before upload, this after. */
  readonly pushedHash: string | null;
  /** The last Live this device made the profile equal. null until the first join completes. */
  readonly applied: Live<R> | null;
  readonly peers: ReadonlyMap<DeviceId, PeerCopy<R>>;
};

/**
 * The last file from a peer that parsed and passed the seq check. Used whenever the current file is
 * unreadable or rolled back, so that peer's `acked` still gates GC. Without it a skipped peer would drop
 * out of the GC quorum, and GC could collect a tombstone that peer never saw.
 */
export type PeerCopy<R extends Rec> = { readonly seq: number; readonly lastGood: StateFile<R> };

export interface Clock {
  now(): number;
}
