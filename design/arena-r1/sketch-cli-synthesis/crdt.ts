// The generic register layer, written once for every data type (p3 variant B).
// Pure and deterministic in its arguments. That determinism is what makes a sync crash-convergent.
import type { DeviceId, Hlc, HlcState, ItemId, Live, Rec, Replica } from './model.ts';

/** Next stamp, strictly greater than `prev` and every stamp seen in the store. One stamp per type per cycle. */
export function tick(_prev: HlcState, _nowMs: number, _newestSeen: Hlc | null, _self: DeviceId): { state: HlcState; stamp: Hlc } {
  throw new Error('not implemented');
}

export function newestStamp(_replicas: Iterable<Replica<Rec>>): Hlc | null {
  throw new Error('not implemented');
}

/** Per register, the higher stamp wins. Commutative, associative, idempotent. */
export function mergeReplicas<R extends Rec>(_replicas: readonly Replica<R>[]): Replica<R> {
  throw new Error('not implemented');
}

/**
 * Fold this device's profile edits into the merged replica.
 *
 * A field gets `stamp` only when `observed != applied` AND `observed != merged`. The second condition is
 * what keeps a half-applied or deferred apply from re-stamping a remote value as a fresh local edit.
 * An id in `applied` but absent from `observed` gets deleted=[true, stamp] unless `merged` already says so.
 * An id in neither `applied` nor `merged` becomes a new entry.
 * `applied === null` is a first join. New items are added, matched items keep the merged values, and nothing is deleted.
 */
export function foldLocalChanges<R extends Rec>(
  _merged: Replica<R>,
  _applied: Live<R> | null,
  _observed: Live<R>,
  _stamp: Hlc,
): Replica<R> {
  throw new Error('not implemented');
}

/** Drop tombstones, then let the type repair cross-item invariants with the dead records as history. */
export function materialize<R extends Rec>(_replica: Replica<R>, _normalize: (live: Live<R>, dead: Live<R>) => Live<R>): Live<R> {
  throw new Error('not implemented');
}

/**
 * Per author, the newest stamp of that author this device has merged. Published in every state file.
 * This is sound because state files are full state. Holding author A's stamp s2 implies holding every earlier A stamp.
 */
export type Acked = ReadonlyMap<DeviceId, Hlc>;

/** Never lower than `previous`, because GC may remove the stamp that set the high-water mark. */
export function ackedOf<R extends Rec>(_replica: Replica<R>, _previous: Acked): Acked {
  throw new Error('not implemented');
}

/**
 * Drop a tombstone stamped `s` by author `a` once every live device's Acked holds `a` at `s` or later.
 * Idle devices are not in `acks`. They are also excluded from merge, so they cannot resurrect what GC dropped.
 */
export function collectGarbage<R extends Rec>(_merged: Replica<R>, _acks: readonly Acked[]): Replica<R> {
  throw new Error('not implemented');
}

export type Change<R extends Rec> =
  | { readonly op: 'add'; readonly id: ItemId; readonly after: R }
  | { readonly op: 'update'; readonly id: ItemId; readonly before: R; readonly after: R }
  | { readonly op: 'remove'; readonly id: ItemId; readonly before: R };

export function diffLive<R extends Rec>(_from: Live<R>, _to: Live<R>): readonly Change<R>[] {
  throw new Error('not implemented');
}

/**
 * Mass-delete guard. Non-null when the read looks like the wrong profile or a file caught mid-write
 * (empty while `applied` was not, or more than `fraction` of at least `minItems` items gone).
 */
export function massDelete<R extends Rec>(
  _applied: Live<R> | null,
  _observed: Live<R>,
  _limits: { readonly minItems: number; readonly fraction: number },
): { readonly removed: number; readonly of: number } | null {
  throw new Error('not implemented');
}
