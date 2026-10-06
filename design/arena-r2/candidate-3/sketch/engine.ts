// The deep module. The service worker calls `sync` and stores the plain-JSON report for the popup.
// Ordering, merging, stamping, GC, eviction, rollback checks, sharding, expiry, deferral, and crash safety
// live behind it. Round 1 (sketch-cli-synthesis/engine.ts) cycle, with the changes listed under "Changes".
//
// The engine takes no lock, holds no state between calls, and never reads a clock except through `deps`.
// The runtime builds one per wake. "Terminated mid-cycle" and "crashed mid-cycle" are the same event.
import type { DeviceId, ShardKey } from './model.ts';
import type { Budget, Clock, LocalState, Profile, Store, StoreAccess } from './ports.ts';
import type { Registry } from './registry.ts';
import type { Codec, Platform } from './store-format.ts';

export type EngineDeps<Reg extends Registry> = {
  readonly registry: Reg;
  readonly store: Store;
  readonly profile: Profile<Reg>;
  readonly local: LocalState<Reg>;
  /** The codec this device writes with. v1 has one. */
  readonly codec: Codec;
  readonly clock: Clock;
  readonly platform: Platform;
  readonly appVersion: string;
  readonly policy?: Partial<Policy>;
};

export type Policy = {
  /** A device whose meta.json is older than this is idle. Idle devices are skipped by merge and GC, never deleted. */
  readonly idleAfterDays: number;
  /** Rewrite our meta.json at least this often so peers do not see us as idle. */
  readonly heartbeatHours: number;
  readonly massDelete: { readonly minItems: number; readonly fraction: number };
};
export const defaultPolicy: Policy = { idleAfterDays: 90, heartbeatHours: 24, massDelete: { minItems: 20, fraction: 0.5 } };

export type SyncOptions = {
  /** Compute and report everything. Write nothing to the store, the profile, or local state. The setup page's "preview" uses this. */
  readonly dryRun?: boolean;
  /** Types whose mass-delete block the user confirmed in the popup. */
  readonly force?: readonly string[];
  /** Checked between shards. Omitted means unlimited (tests). */
  readonly budget?: Budget;
};

export interface Engine {
  /** One bounded cycle. Idempotent. Safe from any trigger. `complete: false` means the budget ran out and a rerun continues. */
  sync(opts?: SyncOptions): Promise<SyncReport>;
  /** Delete this device's files from the store ("Remove this device"). Peers keep everything it contributed. */
  forget(): Promise<void>;
}

export function createEngine<const Reg extends Registry>(_deps: EngineDeps<Reg>): Engine {
  throw new Error('not implemented');
}

// ---------- Report. Plain data, safe to serialise into chrome.storage and render in any page ----------

export type SyncReport = {
  readonly device: DeviceId;
  readonly at: number;
  readonly dryRun: boolean;
  /** false when work remains that a rerun can do: the budget ran out, or chrome.bookmarks hit its write quota. The runtime reschedules instead of waiting for the next trigger. */
  readonly complete: boolean;
  readonly store: StoreAccess;
  /** Empty when `store` is not ok. */
  readonly types: { readonly [type: string]: TypeOutcome };
  readonly peers: readonly Peer[];
  readonly warnings: readonly Warning[];
};

export type ChangeSummary = {
  readonly added: number;
  readonly updated: number;
  readonly removed: number;
  /** A handful of human lines. History can have thousands of changes, so the report never lists them all. */
  readonly sample: readonly string[];
};

export type TypeOutcome =
  | { readonly kind: 'synced'; readonly shards: number; readonly published: boolean; readonly applied: ChangeSummary }
  | {
      readonly kind: 'pending';
      readonly shards: number;
      readonly published: boolean;
      /** Recomputed every cycle as diff(current, materialize(merged)) per shard. Never queued. */
      readonly pending: ChangeSummary;
      /** quota: chrome.bookmarks write limit. budget: this wake ran out of time; the newest shards went first. */
      readonly why: 'quota' | 'budget';
    }
  /** Nothing published and nothing applied for this type. */
  | { readonly kind: 'blocked'; readonly why: Blocked };

export type Blocked =
  | { readonly kind: 'mass-delete'; readonly removed: number; readonly of: number }
  | { readonly kind: 'newer-type-version'; readonly peer: DeviceId; readonly version: number }
  /** Our own file in the store has a higher seq than we wrote. Another install writes our DeviceId. */
  | { readonly kind: 'identity-clash'; readonly shard: ShardKey };

export type Warning =
  | { readonly kind: 'rollback'; readonly peer: DeviceId; readonly type: string; readonly shard: ShardKey; readonly seen: number; readonly got: number }
  | { readonly kind: 'unreadable'; readonly name: string; readonly detail: string }
  | { readonly kind: 'unknown-codec'; readonly peer: DeviceId; readonly codec: string }
  /** Conflict copies, temp files, placeholders. Reported, never merged. */
  | { readonly kind: 'foreign-file'; readonly name: string }
  | { readonly kind: 'rejoined'; readonly previous: DeviceId };

export type Peer = { readonly device: DeviceId; readonly name: string; readonly lastSeen: number; readonly idle: boolean };

/*
 * Changes from round 1's cycle. `sync(opts)`, no lock inside (the scheduler holds the Web Lock):
 *
 *   access = store.access()                 // NEW. not ok: return a report with `store` set and no types. No throw.
 *   me, idle check, store.list, metas       // unchanged, but list() is recursive and returns versions
 *
 *   per type T in registry order:           // bookmarks, then history
 *     observed  = retain(channel.read(previous), T, now)           // once per type; `previous` loads one shard's applied lazily
 *     byShard   = partition(observed, T)
 *     shards    = byShard.keys + shards of live peers in the store + local.shards(T), minus wholly expired
 *     for shard S in descending key order:                         // history: today first
 *       if budget.expired(): outcome pending 'budget'; stop the whole cycle with complete=false
 *       body = round 1's per-type body, applied to (T, S) with:
 *         tl      = local.shard(T, S)
 *         peers   = per live peer: skip the fetch when StoreEntry.version == tl.peers[p].version; every replica goes through retainReplica
 *         publish = local.commit({ core, shard: own+seq+1 })  ->  store.put  ->  local.commit({ shard: pushedHash })
 *         apply   = channel.apply({ shard: S, current: byShard[S], target })   // 'applied' advances applied; 'deferred quota' does not
 *         local.commit({ shard: applied, peers })
 *       Each shard commits independently, so a kill between shards loses nothing.
 *     expire: our own store files for wholly expired shards are deleted (one-writer rule holds), then local.commit({ drop })
 *
 *   heartbeat meta, as before.
 *
 * Mass-delete guard (massDelete) runs per type over `observed` vs the union of `applied`, as before.
 * `retain` runs on both sides first, so aging out of the 90-day window is never read as a delete.
 *
 * Why a kill is safe, point by point (the worker can die at any await):
 *   before the pre-publish commit    nothing durable changed. Rerun redoes the shard.
 *   after commit, before store.put   rerun finds pushedHash != hash and re-uploads identical bytes. Nothing is re-stamped.
 *   during store.put                 FSA writes to a swap file and commits on close; a killed write leaves the old file.
 *   after put, before pushedHash     rerun uploads identical bytes once more. Idempotent.
 *   mid chrome.bookmarks apply       some ops landed. Rerun reads the half-applied tree; the fold rule sees observed == merged
 *                                    for those fields and stamps nothing; adoption re-binds nodes created before their id was saved.
 *   after apply, before `applied`    rerun sees current == target and just advances `applied`.
 *   mid corpus write                 one IndexedDB transaction per shard. All or nothing.
 */
