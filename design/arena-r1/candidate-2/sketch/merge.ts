// Pure functions over DeviceState/Snapshot. No I/O, no knowledge of any concrete data type.
// Ported from P3 variant B (the merge that converged in every scenario with zero folder conflicts).

import type { DataType, DeviceId, DeviceState, Fields, ItemId, Snapshot, Stamp } from './datatype.ts';
import type { DeviceCard } from './wire.ts';

/** Register-wise max by stamp across all device files. Commutative, associative, idempotent. */
export function mergeStates<F extends Fields>(states: Iterable<DeviceState<F>>): DeviceState<F> {
  throw new Error('not implemented');
}

/** Live items with current register values, then `type.repair` (orphan re-homing etc). */
export function materialize<F extends Fields>(state: DeviceState<F>, type: DataType<F>): Snapshot<F> {
  throw new Error('not implemented');
}

/**
 * Fold the user's edits into `merged`. An edit is any field where `snapshot[id][k]` differs (Json deep-equal)
 * from `baseline[id][k]`; an id in baseline but not in snapshot is a deletion; an id in neither baseline nor
 * merged is a fresh item. Every change gets the same `stamp`. Items the user did not touch are returned as they
 * are in `merged`, so this device's file carries the full merged state (device eviction stays safe).
 */
export function stampChanges<F extends Fields>(
  merged: DeviceState<F>,
  baseline: Snapshot<F> | null,
  snapshot: Snapshot<F>,
  fieldKeys: readonly string[],
  stamp: Stamp,
): DeviceState<F> {
  throw new Error('not implemented');
}

/** Rewrite ids (and id-valued fields, via `rewriteRefs`) through an alias map. Used after first-join adoption. */
export function remapIds<F extends Fields>(
  snapshot: Snapshot<F>,
  aliases: ReadonlyMap<ItemId, ItemId>,
  rewriteRefs: (fields: F, map: (id: ItemId) => ItemId) => F,
): Snapshot<F> {
  throw new Error('not implemented');
}

/** Highest stamp in a state, for HLC observation. */
export function maxStamp<F extends Fields>(state: DeviceState<F>): Stamp | null {
  throw new Error('not implemented');
}

/**
 * Drop a tombstone once every live device's last-sync stamp is newer than it (everyone has seen the delete).
 * Devices idle longer than `idleMs` are not counted as live; the engine evicts them separately.
 */
export function collectGarbage<F extends Fields>(
  state: DeviceState<F>,
  devices: readonly DeviceCard[],
  nowMs: number,
  idleMs: number,
): DeviceState<F> {
  throw new Error('not implemented');
}

/**
 * Hybrid logical clock. `tick` returns a stamp strictly greater than every stamp this device has issued or
 * observed, even when the wall clock steps backwards. Persisted by `local.ts` between runs.
 */
export class Hlc {
  constructor(readonly device: DeviceId, private last: { wall: number; counter: number }) {}
  tick(observed: Stamp | null, wallMs: number): Stamp {
    throw new Error('not implemented');
  }
  snapshot(): { wall: number; counter: number } {
    throw new Error('not implemented');
  }
}
