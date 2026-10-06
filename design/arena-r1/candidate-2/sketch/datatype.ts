// The data-type contract. Adding a synced data type = one `defineDataType` call + one entry in `registry.ts`.
// Everything else (merge, wire format, store layout, daemon, CLI) is generic over `F`.

import type { ProfileDir, WritableProfile } from './profile.ts';

export type Json = string | number | boolean | null | readonly Json[] | { readonly [k: string]: Json };

/** A data type is defined by its field record. Values must be Json so the wire format is derived, not written. */
export type Fields = { readonly [k: string]: Json };

declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

/** Stable across devices. For bookmarks this is the Chromium guid; for history a hash of (url, visitTime). */
export type ItemId = Brand<string, 'ItemId'>;
export type DeviceId = Brand<string, 'DeviceId'>;
/** HLC stamp `wall36.counter36.deviceId`, fixed-width, so `a > b` as strings is causal order. Never parsed by the merge. */
export type Stamp = Brand<string, 'Stamp'>;

export type Register<T> = readonly [value: T, stamp: Stamp];

/** One synced item: a register per field plus a deletion register. Delete beats concurrent edit (P3). */
export type Item<F extends Fields> = {
  readonly fields: { readonly [K in keyof F]: Register<F[K]> };
  readonly deleted: Register<boolean>;
};

/** Everything one device knows about a type. The unit written to the store; each device writes only its own. */
export type DeviceState<F extends Fields> = ReadonlyMap<ItemId, Item<F>>;

/** What the browser shows: same ids, bare values, no stamps. Produced by `read`, consumed by `write`. */
export type Snapshot<F extends Fields> = ReadonlyMap<ItemId, F>;

export interface DataType<F extends Fields> {
  readonly name: string;
  /**
   * Keys the generic diff iterates. Typed as `keyof F` on the `defineDataType` spec, widened here on purpose:
   * `keyof F` on the interface makes TS measure `F` as invariant and `DataType<BookmarkFields>` stops being
   * assignable to `DataType<Fields>`, which the registry and engine need.
   */
  readonly fieldKeys: readonly string[];

  /**
   * Read the browser's current contents. May run while Helium is running (profile files are read-only here).
   * `baseline` is the snapshot we last observed; the adapter uses it to carry over values that must not look
   * like edits (bookmarks: fractional positions of unmoved nodes).
   */
  read(profile: ProfileDir, baseline: Snapshot<F> | null): Promise<Snapshot<F>>;

  /**
   * Make the profile show exactly `target`. Only reachable through a `WritableProfile`, which exists only while
   * Helium is closed. Must edit the existing file (preserve unknown fields), not regenerate it.
   * Throws `SchemaUnsupported` when the on-disk schema is outside the tested set; the engine then reports and skips.
   */
  write(profile: WritableProfile, target: Snapshot<F>): Promise<void>;

  /**
   * First join of a device that already has data: map local ids onto remote ids for items that are "the same",
   * or every pre-existing bookmark duplicates (P3: required). Default: identity.
   */
  adopt(local: Snapshot<F>, remote: Snapshot<F>): ReadonlyMap<ItemId, ItemId>;

  /**
   * Restore cross-item invariants after a merge, e.g. re-home a live bookmark whose parent folder is deleted.
   * `tombstoned` looks up the last known fields of a deleted item. Default: identity.
   */
  repair(live: Snapshot<F>, tombstoned: (id: ItemId) => F | undefined): Snapshot<F>;
}

type DataTypeSpec<F extends Fields> = Pick<DataType<F>, 'name' | 'read' | 'write'> &
  Partial<Pick<DataType<F>, 'adopt' | 'repair'>> & { readonly fieldKeys: readonly (keyof F & string)[] };

/** Fills in the identity defaults for `adopt` and `repair`. */
export function defineDataType<F extends Fields>(spec: DataTypeSpec<F>): DataType<F> {
  throw new Error('not implemented');
}

export class SchemaUnsupported extends Error {
  constructor(readonly type: string, readonly found: string) {
    super(`${type}: on-disk schema ${found} is outside the tested set`);
  }
}
