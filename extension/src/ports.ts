// The seams. engine.ts and the two cycle modules import these and the pure modules, never chrome.*, File
// System Access, or IndexedDB, so a whole cycle runs in a Node test against in-memory fakes.
import type { DayKey, DeviceId, Ev, EventKey, HlcState, Live, Rec, Replica, ItemId } from './model.ts';
import type { Acked } from './crdt.ts';
import type { Bookmark } from './bookmarks.ts';
import type { Manifest, RelName, StateFile, StoreKey } from './store-format.ts';

// ---------- Store ----------

/**
 * A dumb blob store. A folder through File System Access in v1 (folder-store.ts); WebDAV is the fallback
 * adapter (webdav-store.ts). The whole contract:
 *  - One writer per key. The layout guarantees it, so no CAS, locking, or list consistency is needed.
 *  - `put` need not be atomic. Readers verify bytes against the writer's manifest, so a torn file is "not yet".
 *  - Every method rejects only with StoreError.
 */
export interface Store {
  /** Names directly under `prefix`, files and folders alike. The engine parses them; foreign names are reported. */
  list(prefix: string): Promise<readonly string[]>;
  /** `known` is the version this device last read. A folder compares lastModified + size, WebDAV an ETag. */
  get(key: StoreKey, known: string | null): Promise<Fetched>;
  put(key: StoreKey, bytes: Uint8Array): Promise<void>;
  /** Missing is success. Removes parent folders the delete leaves empty. */
  delete(key: StoreKey): Promise<void>;
  /** Write, read back, and delete a scratch file outside `devices/`. Setup runs it before Start; status on demand. */
  probe(): Promise<ProbeResult>;
}

export type Fetched =
  | { readonly kind: 'ok'; readonly bytes: Uint8Array; readonly version: string }
  | { readonly kind: 'unchanged' }
  /** Not there, or not materialized yet (an iCloud placeholder). Never read as "deleted" by itself. */
  | { readonly kind: 'missing' };

export type ProbeResult = { readonly kind: 'ok' } | { readonly kind: 'failed'; readonly why: StoreFailure };

/** Every way a store fails, in the words the popup uses. Shared by connect, probe, and mid-cycle errors. */
export type StoreFailure =
  /** The folder grant lapsed (P7 rungs B, C), or a WebDAV origin's host permission was revoked. */
  | { readonly kind: 'needs-permission' }
  /** The folder was moved, renamed, or deleted. The user picks it again. */
  | { readonly kind: 'missing' }
  /** WebDAV only: offline or the server is down. A folder on local disk is never unreachable. */
  | { readonly kind: 'unreachable'; readonly detail: string }
  /** The store refused a write or the credentials. */
  | { readonly kind: 'rejected'; readonly detail: string };

export class StoreError extends Error {
  readonly why: StoreFailure;
  constructor(why: StoreFailure) {
    super(why.kind);
    this.why = why;
  }
}

/**
 * Whether the store can be used right now. Decided at the start of every cycle, because folder permission can
 * lapse across a browser restart. A `Store` exists only in the `ready` variant, so no code path can write
 * without access.
 */
export type StoreConnection =
  | { readonly access: 'ready'; readonly label: string; readonly store: Store }
  | { readonly access: 'failed'; readonly label: string; readonly why: StoreFailure }
  | { readonly access: 'not-set-up' };

type WithoutStore<T> = T extends unknown ? Omit<T, 'store'> : never;
/** What the UI shows. Derived, so a new access state reaches the popup's switch without edits. */
export type StoreStatus = WithoutStore<StoreConnection>;

// ---------- Profile side: register types ----------

/** Inside the extension Helium always runs and the API always writes, so there are no session modes. */
export interface RegisterChannel<R extends Rec> {
  /** Current profile content keyed by ItemId. Unknown local nodes get a freshly minted, persisted ItemId. */
  read(previous: Live<R> | null): Promise<Live<R>>;
  /** Local ItemId `from` is synced ItemId `to` (from adoption). Persisted before returning. */
  bind(aliases: ReadonlyMap<ItemId, ItemId>): Promise<void>;
  /**
   * Make the profile equal `target` with API calls, checking `budget` between calls. Safe to re-run: the next
   * cycle recomputes the remaining diff from what the profile shows, so nothing is queued.
   */
  apply(change: { readonly current: Live<R>; readonly target: Live<R> }, budget: Budget): Promise<ApplyResult>;
}

export type ApplyResult =
  | { readonly kind: 'applied' }
  /** The budget ran out between calls. The next wake continues. */
  | { readonly kind: 'stopped' }
  /** An API call failed, usually because the user edited the same node mid-apply. */
  | { readonly kind: 'interrupted'; readonly detail: string };

// ---------- Profile side: log types ----------

/** Read-only. helium-sync never writes chrome.history. */
export interface LogSource<E extends Ev> {
  /** Events this profile itself made in [from, to). History: isLocal, http(s) only. */
  collect(from: number, to: number): Promise<readonly E[]>;
}

export type PeerRef = { readonly device: DeviceId; readonly name: string };

/**
 * What "apply" means for a log type. History: the peer index the History page and omnibox search. The opt-in
 * companion decorates this sink (companion/link.ts); the engine never knows.
 */
export interface LogSink<E extends Ev> {
  /** Replace everything indexed for (peer, day) with `events`. Idempotent. */
  put(from: PeerRef, day: DayKey, events: readonly E[]): Promise<void>;
  drop(device: DeviceId, day: DayKey): Promise<void>;
}

export type LogPorts<E extends Ev> = { readonly source: LogSource<E>; readonly sink: LogSink<E>; readonly local: LogLocal<E> };

// ---------- Device-private state ----------

/** IndexedDB in the extension (local.ts). Written only by the service worker, inside the cycle lock. */
export interface LocalState {
  /** null until setup ran on this device. */
  load(): Promise<DeviceLocal | null>;
  /** One IndexedDB transaction. */
  save(next: DeviceLocal): Promise<void>;
  /** New DeviceId and empty sync state; keeps the chrome id map. Setup's Start, change folder, idle rejoin. */
  reset(setup: { readonly name: string; readonly historyOn: boolean }): Promise<DeviceLocal>;
  /** Forget this device: clears everything but the chrome id map, so `load` returns null. */
  clear(): Promise<void>;
}

/**
 * User intents that must survive the worker dying, as monotonic counters. The scheduler bumps them; the engine
 * acts when a count exceeds the one it last handled. Acting twice on one count is impossible by construction.
 */
export type Asks = {
  /** chrome.history.onVisitRemoved. Re-derives every own history day. */
  readonly rederiveHistory: number;
  /** The user reviewed a blocked mass delete and pressed "Apply these deletions". */
  readonly applyDeletions: number;
};

export const noAsks: Asks = { rederiveHistory: 0, applyDeletions: 0 };

export type DeviceLocal = {
  readonly device: DeviceId;
  readonly name: string;
  readonly historyOn: boolean;
  readonly clock: HlcState;
  readonly lastSeen: number | null;
  /** Seq of the last manifest this device put. */
  readonly manifestSeq: number;
  /** What our last confirmed manifest lists. `plain` lets a cycle skip re-sealing unchanged content. */
  readonly published: ReadonlyMap<RelName, Published>;
  readonly peers: ReadonlyMap<DeviceId, PeerLocal>;
  readonly handled: Asks;
  readonly bookmarks: RegisterLocal<Bookmark> | null;
  readonly history: LogCursor;
};

/** The state a device starts with after setup, a folder change, or an idle rejoin. */
export function freshDeviceLocal(device: DeviceId, setup: { readonly name: string; readonly historyOn: boolean }, history: LogCursor): DeviceLocal {
  return {
    device,
    name: setup.name,
    historyOn: setup.historyOn,
    clock: { wall: 0, counter: 0 },
    lastSeen: null,
    manifestSeq: 0,
    published: new Map(),
    peers: new Map(),
    handled: noAsks,
    bookmarks: null,
    history,
  };
}

export type Published = { readonly plain: string; readonly hash: string; readonly bytes: number };

export type PeerLocal = {
  /** Version of the manifest bytes last read. An unchanged peer costs one cheap `get`. */
  readonly version: string | null;
  /** Last manifest that parsed and passed the seq check. Stands in while the store is unreachable. */
  readonly manifest: Manifest | null;
};

export type RegisterLocal<R extends Rec> = {
  readonly own: Replica<R>;
  /** Our published high-water marks, kept so GC cannot lower them (see crdt.ts `ackedOf`). */
  readonly acked: Acked;
  readonly seq: number;
  readonly applied: Live<R> | null;
  /** Per peer, the last file that matched its manifest and passed the seq check. */
  readonly peers: ReadonlyMap<DeviceId, { readonly seq: number; readonly hash: string; readonly lastGood: StateFile<R> }>;
};

export type LogCursor = {
  /** Events before this are in own days. The next scan re-reads `slackMs` before it (Chromium commits in ~10 s batches). */
  readonly watermark: number;
  /**
   * Days still to derive in replace mode, walked newest first, one day per unit of work. Join backfill and
   * re-derive are the same walk. null when nothing is left.
   */
  readonly derive: { readonly next: DayKey; readonly oldest: DayKey } | null;
  /** When the last full walk finished. A walk restarts at least every `rederiveDays`, to catch silent deletes. */
  readonly lastWalk: number;
};

/** Log payloads, too large to rewrite with DeviceLocal every cycle. A persistence port with no policy. */
export interface LogLocal<E extends Ev> {
  ownDays(): Promise<ReadonlyMap<DayKey, OwnDay>>;
  ownEvents(day: DayKey): Promise<readonly E[]>;
  saveOwnDay(day: DayKey, events: readonly E[], meta: OwnDay): Promise<void>;
  deleteOwnDay(day: DayKey): Promise<void>;
  /** Peer shards applied to the sink, by store key, with the manifest hash applied. */
  peerDays(): Promise<ReadonlyMap<StoreKey, string>>;
  setPeerDay(key: StoreKey, hash: string | null): Promise<void>;
  /** The echo guard: keys of every peer event this device ever handed its sink. */
  ingested(keys: readonly EventKey[]): Promise<ReadonlySet<EventKey>>;
  markIngested(events: readonly { readonly key: EventKey; readonly t: number }[]): Promise<void>;
  /** Drop peer-day marks and ingested keys older than `before`. */
  expire(before: number): Promise<void>;
}

export type OwnDay = { readonly plain: string; readonly count: number };

// ---------- Runtime ----------

/** How much of this wake the engine may still spend. Checked between units of work, never inside one. */
export interface Budget {
  expired(): boolean;
}

export const unbounded: Budget = { expired: () => false };

export interface Clock {
  now(): number;
}
