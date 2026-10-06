// Pure merge model (P3 variant B): per-device full-state files, per-field LWW registers stamped by an HLC.
// No I/O. Every function here is deterministic in its arguments, which is what makes sync crash-convergent.

import type { DeviceId, Live, Rec, Replica, Stamp } from './model.ts';

/** HLC state persisted per device. */
export type Clock = { readonly wall: number; readonly counter: number };

/** Advance the clock past both local wall time and the newest stamp seen in the store. One stamp per sync run. */
export function tick(prev: Clock, nowMs: number, newestSeen: Stamp | undefined, self: DeviceId): { clock: Clock; stamp: Stamp } {
  // TODO: l = max(prev.wall, seen.wall, now); counter resets only when l === now strictly exceeds both.
  throw new Error('not implemented');
}

/** Per register, the higher stamp wins. `deleted` is a register too, so a later delete beats an earlier edit. */
export function mergeReplicas<R extends Rec>(replicas: readonly Replica<R>[]): Replica<R> {
  throw new Error('not implemented');
}

/**
 * Fold this device's browser changes into the merged state.
 * `view === null` means first join for this type: items not already in `merged` are added, nothing is deleted.
 * Otherwise: a field gets `stamp` only if observed != view AND observed != the value already in `merged`;
 * items in view but not observed get deleted=true unless `merged` already says deleted.
 * The second condition is what makes a crashed run's retry stamp nothing: a half-realized browser already
 * shows merged values, so it reads as "no change", not as a fresh local edit.
 */
export function foldLocalChanges<R extends Rec>(
  merged: Replica<R>,
  view: Live<R> | null,
  observed: Live<R>,
  stamp: Stamp,
): Replica<R> {
  throw new Error('not implemented');
}

/** Drop tombstones, then let the type repair its invariants with the dead records available as history. */
export function materialize<R extends Rec>(replica: Replica<R>, normalize: (live: Live<R>, dead: Live<R>) => Live<R>): Live<R> {
  throw new Error('not implemented');
}

/**
 * A tombstone may be dropped once every live peer's file holds it with a stamp >= ours.
 * Evicted peers do not count; they rejoin through adoption.
 */
export function collectGarbage<R extends Rec>(own: Replica<R>, livePeers: readonly Replica<R>[]): Replica<R> {
  throw new Error('not implemented');
}

export type Policy = {
  /** Peers whose file was last written longer ago are ignored and must rejoin. */
  readonly evictAfterDays: number;
  /** Rewrite our file at least this often even if unchanged, so peers do not evict us. */
  readonly heartbeatHours: number;
};
export const defaultPolicy: Policy = { evictAfterDays: 90, heartbeatHours: 24 };

/** Only write when content changed or the heartbeat is due. Unchanged writes would churn the sync folder. */
export function shouldWrite(contentChanged: boolean, lastWrittenAt: Stamp | undefined, nowMs: number, policy: Policy): boolean {
  throw new Error('not implemented');
}

export function isEvicted(writtenAt: Stamp, nowMs: number, policy: Policy): boolean {
  throw new Error('not implemented');
}

export function newestStamp(replicas: readonly Replica<Rec>[]): Stamp | undefined {
  throw new Error('not implemented');
}
