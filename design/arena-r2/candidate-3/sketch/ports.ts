// The seams. The engine imports these and the pure modules, never chrome.*, IndexedDB, or FSA.
// Round 1 (sketch-cli-synthesis/ports.ts) changes:
//   Store         + access() preflight, + StoreEntry.version, - watch (no event source in an extension; the runtime polls)
//   Profile       ProfileSession and its offline/live/read-only modes are gone. The extension is always "live",
//                 so Profile is just a channel factory. No `channelFor` switch, no WritableProfile capability.
//   LocalState    state.json + pid lock became per-shard IndexedDB commits. `lock` left the port: the cycle lock
//                 is a Web Lock owned by runtime/scheduler.ts, because "who may run a cycle" is a runtime question.
//   Budget        new. The engine stops between shards when it expires.
import type { DeviceId, HlcState, ItemId, Live, Rec, Replica, ShardKey } from './model.ts';
import type { RecordOf, Registry, TypeName } from './registry.ts';
import type { StateFile, StoreKey } from './store-format.ts';

// ---------- Store (transport) ----------

/**
 * A dumb blob store: a user-picked folder (FSA) or WebDAV today, anything with these four verbs later.
 * The whole contract:
 *  - `put` is atomic to readers (old bytes or new bytes, never torn), including when the worker dies mid-call.
 *  - One writer per key. The layout guarantees it, so no CAS, locking, or list consistency is needed.
 *  - `get` returning null means "not there yet" (missing, or an unmaterialised cloud placeholder).
 *  - Methods may throw StoreUnavailable. `access()` is how the engine finds out first, once per cycle.
 */
export interface Store {
  /** Preflight. Never throws. `needs-access` means a human must click (FSA permission lapsed after a restart). */
  access(): Promise<StoreAccess>;
  /** Every file under `prefix`, recursively, as store-relative names. The engine parses them, so foreign files cannot pass as keys. */
  list(prefix: string): Promise<readonly StoreEntry[]>;
  get(key: StoreKey): Promise<Uint8Array | null>;
  put(key: StoreKey, bytes: Uint8Array): Promise<void>;
  delete(key: StoreKey): Promise<void>;
}
export type StoreEntry = {
  readonly name: string;
  readonly size: number;
  /** Changes whenever the bytes change (mtime or etag). Lets the engine skip fetch and decode for an unchanged peer file. */
  readonly version: string;
};
export type StoreAccess =
  | { readonly kind: 'ok'; readonly label: string }
  | { readonly kind: 'needs-access'; readonly label: string }
  | { readonly kind: 'unreachable'; readonly detail: string };

/** Thrown by a Store method when access vanished mid-cycle. The engine turns it into a `store` outcome, never a crash. */
export class StoreUnavailable extends Error {
  readonly access: Exclude<StoreAccess, { kind: 'ok' }>;
  constructor(access: Exclude<StoreAccess, { kind: 'ok' }>) {
    super(access.kind);
    this.access = access;
  }
}

// ---------- Profile (browser side) ----------

/** One channel per registered type. Adding a type to the registry fails to compile until the profile has its channel. */
export type Profile<Reg extends Registry> = {
  readonly [K in TypeName<Reg>]: WriteChannel<RecordOf<Reg[K]>>;
};

/** Resolves to the Live this device last made the profile equal for a shard, or null before its first join. */
export type PreviousApplied<R extends Rec> = (shard: ShardKey) => Promise<Live<R> | null>;

export interface WriteChannel<R extends Rec> {
  /**
   * The profile's current content for the whole type, keyed by synced ids. Adapters own id mapping.
   * `previous` lets bookmarks keep positions stable. History ignores it (visits are immutable) and keeps
   * its own incremental index, so a cycle costs O(changed urls), not O(all urls).
   */
  read(previous: PreviousApplied<R>): Promise<Live<R>>;

  /**
   * Local item `from` is synced item `to`. The adapter persists it until its own id scheme makes it moot.
   * Bookmarks: into the remote-origin id map, forever. History: never called (ids are content hashes).
   */
  bind(aliases: ReadonlyMap<ItemId, ItemId>): Promise<void>;

  /**
   * Make one shard of the profile equal `target`. Safe to re-run, and safe to be killed in the middle: the
   * next cycle recomputes the remaining diff from what the profile shows. The engine advances `applied`
   * only on "applied". "applied" means the browser (or the corpus the user searches) will show `target`.
   */
  apply(change: { readonly shard: ShardKey; readonly current: Live<R>; readonly target: Live<R> }): Promise<ApplyResult>;
}
export type ApplyResult =
  | { readonly kind: 'applied' }
  /** chrome.bookmarks allows 1000 writes per hour and 100 per minute. The rest waits for the next cycle. */
  | { readonly kind: 'deferred'; readonly why: 'quota'; readonly remaining: number };

// ---------- Device-private state ----------

/**
 * Never synced. One per extension install, in IndexedDB. Single writer: the service worker, inside the cycle lock.
 * `commit` is one IndexedDB transaction. That is the atomic unit the engine's commit-then-publish rule relies on.
 */
export interface LocalState<Reg extends Registry> {
  /** Creates a fresh DeviceCore with a new DeviceId on first call. */
  device(): Promise<DeviceCore>;
  /** A fresh ShardLocal when none was saved. */
  shard<K extends TypeName<Reg>>(type: K, shard: ShardKey): Promise<ShardLocal<RecordOf<Reg[K]>>>;
  /** Shards with saved state. Drives deletion of our own expired files. */
  shards(type: TypeName<Reg>): Promise<readonly ShardKey[]>;
  commit(write: LocalWrite<Reg>): Promise<void>;
  /** New DeviceId, no shard state. For a device that was idle past the eviction window. */
  reset(): Promise<DeviceCore>;
}

export type LocalWrite<Reg extends Registry> = {
  readonly core?: DeviceCore;
  readonly shard?: { [K in TypeName<Reg>]: { readonly type: K; readonly shard: ShardKey; readonly local: ShardLocal<RecordOf<Reg[K]>> } }[TypeName<Reg>];
  readonly drop?: readonly { readonly type: TypeName<Reg>; readonly shard: ShardKey }[];
};

export type DeviceCore = {
  readonly device: DeviceId;
  readonly name: string;
  readonly clock: HlcState;
  /** Wall ms of our last meta.json write. Drives the heartbeat and the idle-self check. */
  readonly lastSeen: number | null;
};

/** Round 1's TypeLocal, now per shard. Same fields, same meaning, plus `version` on PeerCopy. */
export type ShardLocal<R extends Rec> = {
  /** Our replica as last committed. The source of our own state; the store copy is never read back as input. */
  readonly own: Replica<R>;
  readonly seq: number;
  /** Hash of the plaintext last confirmed in the store. `own` is committed before upload, this after. */
  readonly pushedHash: string | null;
  /** The last Live this device made the shard equal. null until the first join completes. */
  readonly applied: Live<R> | null;
  readonly peers: ReadonlyMap<DeviceId, PeerCopy<R>>;
};

/** The last peer file that parsed and passed the seq check. It gates GC when the current file is unreadable or rolled back. */
export type PeerCopy<R extends Rec> = {
  readonly seq: number;
  readonly lastGood: StateFile<R>;
  /** StoreEntry.version it came from. An unchanged version means unchanged bytes, so no fetch. */
  readonly version: string;
};

export interface Clock {
  now(): number;
}

/**
 * How much of this wake the engine may still spend. The runtime derives it from the 5-minute event cap and
 * hands it down, so the engine can stop between shards instead of being killed inside one.
 */
export interface Budget {
  expired(): boolean;
}
