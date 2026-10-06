// The seams. The engine imports these and the pure modules, never chrome.*, fetch, or IndexedDB.
import type { DeviceId, Ev, HlcState, ItemId, Live, Rec, Replica, ShardId } from './model.ts';
import type { EventOf, LogTypes, RecordOf, Registry, RegisterTypes } from './registry.ts';
import type { FileEntry, Manifest, StateFile, StoreKey } from './store-format.ts';

// ---------- Store (transport) ----------

/** Opaque per-blob version a store hands back (HTTP ETag, S3 ETag, a folder's mtime+size). */
export type Version = string;

/**
 * A dumb blob store reached over the network. WebDAV in v1; S3 next; a helium-sync server once E2E
 * encryption exists. The whole contract:
 *  - One writer per key. The layout guarantees it, so no CAS, locking, or list consistency is needed.
 *  - `put` need not be atomic. Readers verify bytes against the manifest hash and treat a mismatch as "not yet".
 *  - `get(key, known)` may answer `unchanged` when the blob still has version `known`. A conditional GET.
 *  - Methods reject with `StoreError` only. The engine then runs the cycle offline against cached peer copies.
 */
export interface Store {
  /** Keys under `prefix`, recursively. Names are raw; the engine parses them, so foreign files cannot pass as keys. */
  list(prefix: string): Promise<readonly StoreEntry[]>;
  get(key: StoreKey, known: Version | null): Promise<Fetched>;
  put(key: StoreKey, bytes: Uint8Array): Promise<void>;
  delete(key: StoreKey): Promise<void>;
  /** Setup-time check: reachable, credentials accepted, root writable. Creates the root on success. */
  probe(): Promise<ProbeResult>;
}
export type StoreEntry = { readonly name: string; readonly size: number };
export type Fetched =
  | { readonly kind: 'ok'; readonly bytes: Uint8Array; readonly version: Version | null }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'missing' };

export type ProbeResult = { readonly kind: 'ok'; readonly server: string | null } | { readonly kind: 'failed'; readonly why: StoreError };

/** Every way a network store fails, in the words the popup uses. */
export class StoreError extends Error {
  readonly why: StoreFailure;
  constructor(why: StoreFailure) {
    super(why.kind);
    this.why = why;
  }
}
export type StoreFailure =
  | { readonly kind: 'offline' }
  /** chrome.permissions no longer grants the store's origin. The popup shows a Grant button. */
  | { readonly kind: 'no-host-permission'; readonly origin: string }
  | { readonly kind: 'auth-rejected' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'not-a-dav-server'; readonly detail: string }
  | { readonly kind: 'server-error'; readonly status: number };

// ---------- Profile (browser side) ----------

/**
 * The extension runs only while Helium runs, so round 1's offline/live/read-only session union collapses:
 * every channel can write. `channelFor`, `WritableProfile`, and run-state detection are gone from the
 * default path. The opt-in companion (adapters/native-host.ts) is a history sink, not a profile mode.
 */
export interface Profile<Reg extends Registry> {
  registers<K extends RegisterTypes<Reg>>(type: K): RegisterChannel<RecordOf<Reg[K]>>;
  log<K extends LogTypes<Reg>>(type: K): LogChannel<EventOf<Reg[K]>>;
}

export interface RegisterChannel<R extends Rec> {
  /**
   * The browser's current content in domain terms, keyed by ItemId. Items with no map entry get a freshly
   * minted ItemId (persisted), so adoption can alias them. `previous` is the applied view, used to keep
   * derived values stable (bookmark positions).
   */
  read(previous: Live<R> | null): Promise<Live<R>>;
  /** Local item `from` is synced item `to`. The adapter rewrites its map; the fresh id was never published. */
  bind(aliases: ReadonlyMap<ItemId, ItemId>): Promise<void>;
  /**
   * Make the browser equal `target`. Safe to re-run. Per-item failures (a URL the API rejects) are
   * reported, not thrown. The engine advances `applied` only when a re-read equals `target`.
   */
  apply(change: { readonly current: Live<R>; readonly target: Live<R> }): Promise<ApplyResult>;
}
export type ApplyResult = { readonly kind: 'applied' } | { readonly kind: 'partial'; readonly failed: ReadonlyMap<ItemId, string> };

export interface LogChannel<E extends Ev> {
  /**
   * New local events since `cursor`. The adapter owns the cursor shape and the echo rule (events the
   * adapter itself ingested are not local events). Backfill of pre-install history happens here too,
   * one day per call, newest first, until `cursor.backfillBefore` reaches retention.
   */
  collect(cursor: LogCursor): Promise<{ readonly events: readonly E[]; readonly cursor: LogCursor }>;
  /**
   * Remote events, already deduped against what this device ingested before. What "apply" means is the
   * adapter's decision; see adapters/chrome-history.ts for the three answers.
   */
  ingest(from: DeviceId, events: readonly E[]): Promise<void>;
}
export type LogCursor = {
  /** Wall ms of the newest local event already collected. */
  readonly collectedTo: number;
  /** Start of the oldest day already backfilled; null once backfill is complete. */
  readonly backfillBefore: number | null;
};

// ---------- Device-private state ----------

/**
 * Never synced. One per installation, in IndexedDB. Round 1's single state.json split into object stores
 * because history shards made the blob large and mostly unchanged per cycle. `save` and the slot `put`s
 * are each one transaction, so a service-worker death between them leaves a consistent prefix.
 */
export interface LocalState<Reg extends Registry> {
  /** Creates a fresh DeviceLocal with a new DeviceId on first call. */
  load(): Promise<DeviceLocal>;
  save(next: DeviceLocal): Promise<void>;
  registers<K extends RegisterTypes<Reg>>(type: K): Slot<RegisterLocal<RecordOf<Reg[K]>>>;
  log<K extends LogTypes<Reg>>(type: K): LogLocal<EventOf<Reg[K]>>;
  /** New DeviceId, everything else empty. For a device that was idle past the eviction window. */
  reset(): Promise<DeviceLocal>;
}

export interface Slot<T> {
  get(): Promise<T | null>;
  put(value: T): Promise<void>;
}

export type DeviceLocal = {
  readonly device: DeviceId;
  readonly name: string;
  readonly clock: HlcState;
  readonly manifestSeq: number;
  /** Wall ms of our last manifest write. Drives the heartbeat and the idle-self check. */
  readonly lastSeen: number | null;
  /** Hash of each file's plaintext as last confirmed in the store. A file is re-put only when its hash differs. */
  readonly pushed: { readonly [rel: string]: string };
  /** Every peer this device has ever discovered. Manifest version drives the conditional GET. */
  readonly peers: ReadonlyMap<DeviceId, PeerLocal>;
};

export type PeerLocal = {
  readonly manifestVersion: Version | null;
  /** Last manifest that parsed. Used as-is when the store is unreachable or the current fetch fails. */
  readonly manifest: Manifest | null;
};

export type RegisterLocal<R extends Rec> = {
  /** Our replica as last committed. The source of our own state; the store copy is never read back as input. */
  readonly own: Replica<R>;
  readonly seq: number;
  /** The last Live this device made the browser equal. null until the first join completes. */
  readonly applied: Live<R> | null;
  /** Per peer: last file that parsed and passed the seq check. Supplies `acked` when the current fetch is skipped. */
  readonly peers: ReadonlyMap<DeviceId, { readonly seq: number; readonly lastGood: StateFile<R>; readonly entry: FileEntry }>;
};

/** Per-shard slots, so a cycle touches only today's shard and whatever peers changed. */
export interface LogLocal<E extends Ev> {
  cursor: Slot<LogCursor>;
  own: ShardSlots<OwnShard<E>>;
  peer(device: DeviceId): ShardSlots<PeerShard>;
  /** Echo guard. True when this device ingested an event with this key, so `collect` must not republish it. */
  ingested(keys: readonly string[]): Promise<ReadonlySet<string>>;
  markIngested(keys: readonly string[]): Promise<void>;
}
export interface ShardSlots<T> {
  list(): Promise<readonly ShardId[]>;
  get(shard: ShardId): Promise<T | null>;
  put(shard: ShardId, value: T): Promise<void>;
  delete(shard: ShardId): Promise<void>;
}
export type OwnShard<E extends Ev> = { readonly events: readonly E[] };
/** We keep the hash we applied, not the events: once ingested they live wherever the sink put them. */
export type PeerShard = { readonly appliedHash: string };

export interface Clock {
  now(): number;
}
