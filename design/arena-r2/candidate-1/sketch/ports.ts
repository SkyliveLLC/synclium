// The seams. engine.ts and history.ts import these and the pure modules, never chrome.* or File System
// Access types, so the whole cycle runs in a Node test against in-memory fakes.
import type { DeviceId, HlcState, ItemId, Live, Rec, Replica } from './model.ts';
import type { Bookmark } from './bookmarks.ts';
import type { DayKey, Visit, VisitKey } from './history.ts';
import type { StateFile, StoreKey } from './store-format.ts';

// ---------- Store (round 1 contract, plus `version`) ----------

/**
 * A dumb blob store. One writer per key (the layout guarantees it), `put` atomic to readers, `get` null
 * means "not there yet". A folder through File System Access in v1.
 */
export interface Store {
  list(prefix: string): Promise<readonly StoreEntry[]>;
  get(key: StoreKey): Promise<Uint8Array | null>;
  put(key: StoreKey, bytes: Uint8Array): Promise<void>;
  delete(key: StoreKey): Promise<void>;
}

/**
 * `version` changes whenever the bytes may have changed (folder: lastModified + size). Readers skip a
 * peer file whose version they already parsed. New since round 1: history has ~90 files per device, and
 * the service worker should not re-download them every five minutes.
 */
export type StoreEntry = { readonly name: string; readonly version: string; readonly downloaded: boolean };

/**
 * Whether the store can be used right now. Re-evaluated at the start of every cycle, because folder
 * permission can lapse across a browser restart. A `Store` exists only in the `ready` variant, so no code
 * path can write without access.
 */
export type StoreConnection =
  | { readonly access: 'ready'; readonly folder: string; readonly store: Store }
  /** The handle is fine but Chromium wants the user to confirm again. The popup shows "Allow". */
  | { readonly access: 'needs-permission'; readonly folder: string }
  /** The folder was moved, renamed, or deleted. The user picks it again. */
  | { readonly access: 'missing'; readonly folder: string }
  | { readonly access: 'not-set-up' };

type WithoutStore<T> = T extends unknown ? Omit<T, 'store'> : never;
/** What the UI shows. Derived, so a new access state reaches the report without edits. */
export type StoreStatus = WithoutStore<StoreConnection>;

// ---------- Profile side: bookmarks ----------

/**
 * Round 1's WriteChannel, with the session modes gone. Inside the extension the browser is always running
 * and chrome.bookmarks always writes, so there is no offline / read-only split to negotiate.
 */
export interface Channel<R extends Rec> {
  /** Current profile content keyed by ItemId. Unknown local nodes get a freshly minted, persisted ItemId. */
  read(previous: Live<R> | null): Promise<Live<R>>;
  /** Local ItemId `from` is synced ItemId `to` (from adoption). Persisted before returning. */
  bind(aliases: ReadonlyMap<ItemId, ItemId>): Promise<void>;
  /**
   * Make the profile equal `target` with API calls. Safe to re-run. The service worker can die between any
   * two calls; the next cycle recomputes from what the profile shows, and adoption claims nodes created
   * before the id map was saved.
   */
  apply(change: { readonly current: Live<R>; readonly target: Live<R> }): Promise<ApplyResult>;
}
export type ApplyResult =
  | { readonly kind: 'applied' }
  /** An API call failed, usually because the user edited the same node mid-apply. `applied` stays put. */
  | { readonly kind: 'interrupted'; readonly detail: string };

// ---------- Profile side: history ----------

export interface HistorySource {
  /**
   * Visits this profile made in [from, to), http(s) only, `isLocal` only. Built from history.search (urls
   * visited in range) plus history.getVisits per url. Read-only: helium-sync never writes chrome.history.
   */
  visitsBetween(from: number, to: number): Promise<readonly Visit[]>;
}

// ---------- Device-private state ----------

/** IndexedDB in the extension. The lock is a Web Lock, so a terminated service worker never leaves it held. */
export interface LocalState {
  lock<T>(fn: () => Promise<T>): Promise<T>;
  /** null until setup ran on this device. */
  load(): Promise<DeviceLocal | null>;
  /** One IndexedDB transaction. */
  save(next: DeviceLocal): Promise<void>;
  /** New DeviceId and empty sync state; keeps the chrome id map. Setup, "change folder", and idle rejoin. */
  reset(name: string): Promise<DeviceLocal>;
}

export type DeviceLocal = {
  readonly device: DeviceId;
  readonly name: string;
  readonly clock: HlcState;
  readonly lastSeen: number | null;
  readonly bookmarks: TypeLocal<Bookmark> | null;
  readonly history: HistoryLocal;
};

/** Round 1, unchanged. */
export type TypeLocal<R extends Rec> = {
  readonly own: Replica<R>;
  readonly seq: number;
  readonly pushedHash: string | null;
  readonly applied: Live<R> | null;
  readonly peers: ReadonlyMap<DeviceId, PeerCopy<R>>;
};
/** `version` is new: an unchanged peer file is not re-read. */
export type PeerCopy<R extends Rec> = { readonly seq: number; readonly version: string; readonly lastGood: StateFile<R> };

/** Small, saved with DeviceLocal. Visit payloads live in HistoryDb. */
export type HistoryLocal = {
  /** Visits up to here are folded into own days. The next scan re-reads one minute before it. */
  readonly watermark: number;
  /** Set by any chrome.history.onVisitRemoved, and weekly. The next cycle re-derives every own day. */
  readonly rederive: boolean;
  readonly lastRederive: number;
};

/** History payloads, too large to rewrite with DeviceLocal on every cycle. */
export interface HistoryDb {
  ownDays(): Promise<ReadonlyMap<DayKey, OwnDayMeta>>;
  ownDay(day: DayKey): Promise<readonly Visit[]>;
  saveOwnDay(day: DayKey, meta: OwnDayMeta, visits: readonly Visit[]): Promise<void>;
  deleteOwnDay(day: DayKey): Promise<void>;

  /** Keyed by the shard's store key. */
  peerShards(): Promise<ReadonlyMap<StoreKey, PeerShardMeta>>;
  /** Atomic: the shard's old visits go, the new ones and the meta land, in one transaction. */
  replacePeerShard(meta: PeerShardMeta, visits: readonly Visit[]): Promise<void>;
  dropPeerShard(device: DeviceId, day: DayKey): Promise<void>;
  /** One indexed shard's visits. The companion mirror reads these. */
  peerShardVisits(device: DeviceId, day: DayKey): Promise<readonly Visit[]>;
  /** Keys among `visits` that some peer already published (visits the opt-in companion wrote into Helium). */
  knownFromPeers(visits: readonly Visit[]): Promise<ReadonlySet<VisitKey>>;

  /** For the History tab and the omnibox keyword. Newest first. */
  search(query: string, limit: number): Promise<readonly RemoteVisit[]>;
}
/** `pushedRev < rev` means committed locally but not yet in the store (a crash, or the folder was unreachable). */
export type OwnDayMeta = { readonly rev: number; readonly pushedRev: number };
export type PeerShardMeta = { readonly device: DeviceId; readonly day: DayKey; readonly rev: number; readonly version: string };
export type RemoteVisit = Visit & { readonly device: DeviceId; readonly deviceName: string };

export interface Clock {
  now(): number;
}
