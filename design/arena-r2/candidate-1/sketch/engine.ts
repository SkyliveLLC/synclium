// The deep module. background.ts calls `sync` from alarms and events; the UI reads the report it leaves
// in chrome.storage.local. Store access, merging, stamping, adoption, GC, idle handling, rollback checks,
// history shards, and crash ordering all live behind three methods.
//
// Round 1's engine with three changes: no profile session modes (the extension always writes), store
// access is checked per cycle (folder permission can lapse), and history runs as its own step.
import type { DeviceId } from './model.ts';
import type { Bookmark } from './bookmarks.ts';
import type { Channel, Clock, HistoryDb, HistorySource, LocalState, StoreConnection, StoreStatus } from './ports.ts';
import type { Codec, Platform } from './store-format.ts';
import type { HistoryOutcome, HistoryPolicy } from './history.ts';

export type EngineDeps = {
  /** Called at the start of every cycle. folder-store.ts `connectFolder` in the extension. */
  readonly connect: () => Promise<StoreConnection>;
  readonly bookmarks: Channel<Bookmark>;
  readonly history: HistorySource;
  readonly historyDb: HistoryDb;
  readonly local: LocalState;
  readonly codec: Codec;
  readonly clock: Clock;
  /** Lazy: a worker cannot await at top level, where listeners must be registered. */
  readonly platform: () => Promise<Platform>;
  readonly appVersion: string;
  readonly policy?: Partial<Policy>;
};

export type Policy = {
  readonly idleAfterDays: number;
  readonly heartbeatHours: number;
  readonly massDelete: { readonly minItems: number; readonly fraction: number };
  readonly history: HistoryPolicy;
};

export type SyncOptions = {
  /** Compute and report; write nothing to the store, the profile, or local state. */
  readonly dryRun?: boolean;
  /** Let a blocked mass delete through. Only the app page's "Apply these deletions" button sets it. */
  readonly force?: boolean;
};

export interface Engine {
  /** One full cycle under the local lock. Idempotent; safe from any alarm, event, or button. */
  sync(opts?: SyncOptions): Promise<SyncReport>;
  /** chrome.history.onVisitRemoved. Flags own history for a full re-derive on the next cycle. */
  historyRemoved(): Promise<void>;
  /** Delete this device's files from the store. Peers keep what it contributed. */
  forget(): Promise<void>;
}

export function createEngine(_deps: EngineDeps): Engine {
  throw new Error('not implemented');
}

// ---------- Report: plain JSON, written to chrome.storage.local for the popup and app page ----------

export type SyncReport =
  | { readonly kind: 'needs-setup'; readonly at: number }
  | {
      readonly kind: 'cycle';
      readonly device: DeviceId;
      readonly name: string;
      readonly at: number;
      readonly dryRun: boolean;
      readonly store: StoreStatus;
      readonly bookmarks: BookmarkOutcome;
      readonly history: HistoryOutcome;
      readonly peers: readonly Peer[];
      readonly warnings: readonly Warning[];
    };

export type ChangeLine = { readonly op: 'add' | 'update' | 'remove'; readonly label: string };

export type BookmarkOutcome =
  | { readonly kind: 'synced'; readonly stamped: number; readonly published: boolean; readonly applied: readonly ChangeLine[] }
  /** Folder unreachable. Local edits were stamped and committed; publishing waits for access. */
  | { readonly kind: 'local-only'; readonly stamped: number }
  /** Published, but an API call failed mid-apply. Recomputed next cycle, never queued. */
  | { readonly kind: 'interrupted'; readonly stamped: number; readonly published: boolean; readonly pending: readonly ChangeLine[] }
  /** Nothing published, nothing applied. */
  | { readonly kind: 'blocked'; readonly why: Blocked };

export type Blocked =
  | { readonly kind: 'mass-delete'; readonly removed: readonly ChangeLine[]; readonly of: number }
  | { readonly kind: 'newer-type-version'; readonly peer: DeviceId; readonly version: number }
  /** Our own file has a higher seq than we wrote: a copied profile runs with our DeviceId. */
  | { readonly kind: 'identity-clash' };

export type Warning =
  | { readonly kind: 'rollback'; readonly peer: DeviceId; readonly what: 'bookmarks' | 'history' }
  | { readonly kind: 'unreadable'; readonly name: string; readonly detail: string }
  | { readonly kind: 'not-downloaded'; readonly name: string }
  | { readonly kind: 'unknown-codec'; readonly peer: DeviceId; readonly codec: string }
  | { readonly kind: 'foreign-file'; readonly name: string }
  | { readonly kind: 'rejoined'; readonly previous: DeviceId };

export type Peer = { readonly device: DeviceId; readonly name: string; readonly lastSeen: number; readonly idle: boolean };

/*
 * sync(opts), under local.lock():
 *
 *   me    = local.load(); null -> return needs-setup
 *   conn  = connect()                                   // the only place access is decided
 *   store = conn.access === 'ready' ? conn.store : null
 *   if store and me.lastSeen older than idleAfterDays: delete our old files; me = local.reset(me.name); warn rejoined
 *   metas = store ? parseMeta per devices/<id>/meta.json : the peers we knew      // idle = lastSeen too old
 *
 *   ---- bookmarks: round 1's per-type cycle, unchanged except where marked ----
 *   tl     = me.bookmarks ?? fresh
 *   files  = per live peer p:
 *              no store, or entry.version == tl.peers[p].version   -> tl.peers[p].lastGood      // [new] skip unchanged / offline
 *              else round 1: parse; unreadable or rolled back -> lastGood + warn; newer version -> blocked
 *   own file seq > tl.seq                                           -> blocked identity-clash (only when store)
 *   remote = mergeReplicas([tl.own, ...files]); stamp = tick(...)
 *   raw    = deps.bookmarks.read(tl.applied)                         // the Channel
 *   adopted= bookmarks.adopt({ local: raw, unclaimed, isKnown })      // the DataType; then deps.bookmarks.bind(aliases)
 *   massDelete(tl.applied, adopted.live) and not force             -> blocked mass-delete
 *   merged = collectGarbage(foldLocalChanges(remote, tl.applied, adopted.live, stamp), acks)
 *   target = materialize(merged, bookmarks.normalize)
 *   if hash(merged) != tl.pushedHash:
 *     local.save(own = merged, seq + 1)                             // commit first
 *     if store: store.put(keys.bookmarks(me), seal(StateFile)); local.save(pushedHash)
 *   apply: adopted.live == target -> applied = target
 *          else r = deps.bookmarks.apply({ current: adopted.live, target }); applied moves only on 'applied'
 *   [new] no store: still fold, commit, and apply (the merge of own + lastGood copies), report local-only.
 *         Edits get stamps near the time they were made, not the time the folder came back.
 *
 *   ---- history ----
 *   { local: me.history, outcome } = syncHistory({ store, peers: live peer ids, ... })
 *
 *   if store and (anything published or heartbeatHours elapsed): put meta; lastSeen = now
 *   local.save(me)
 *
 * Crash anywhere converges: the worker can be terminated between any two awaits. `own` is committed before
 * publish, `applied` moves only on proof, and adoption claims nodes an interrupted apply created.
 */
