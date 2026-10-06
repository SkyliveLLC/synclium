// Domain vocabulary shared by every module. Branded ids, the HLC stamp, the register layer, and the
// DataType contract. Pure types plus brand predicates. No I/O, no chrome.*, no Chromium shapes.
// Round 1 (sketch-cli-synthesis/model.ts) with two changes, marked CHANGED: DataType gains `shardOf` and
// `expired`, which history needs. Nothing else in this file moved.

declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

/** One installation on one machine. Minted by LocalState, never reused after an eviction rejoin. */
export type DeviceId = Brand<string, 'DeviceId'>;

/**
 * Cross-device identity of one synced item. The extension API exposes no bookmark guid (P2), so bookmarks
 * get sync-minted ids (adapters/chrome-bookmarks.ts). Visits use a content hash of (url, time).
 */
export type ItemId = Brand<string, 'ItemId'>;

/**
 * Hybrid logical clock stamp `<wall ms, base36, 9>.<counter, base36, 4>.<DeviceId>`.
 * Fixed width, so plain string comparison is the total order. The DeviceId suffix makes ties impossible
 * and names the author, which tombstone GC relies on. Minted only by `tick` in crdt.ts.
 */
export type Hlc = Brand<string, 'Hlc'>;
export type HlcState = { readonly wall: number; readonly counter: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ITEM = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/;
const HLC = /^[0-9a-z]{9}\.[0-9a-z]{4}\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Predicates are the only way to obtain a brand, so no module needs a cast.
export const isDeviceId = (s: string): s is DeviceId => UUID.test(s);
export const isItemId = (s: string): s is ItemId => ITEM.test(s);
export const isHlc = (s: string): s is Hlc => HLC.test(s);

/**
 * A unit of replication inside one data type: one file per device per shard, one commit per shard.
 * Bookmarks have the single shard 'all'. History has one shard per UTC day. Matches [0-9a-z-]{1,16}.
 */
export type ShardKey = Brand<string, 'ShardKey'>;
export const isShardKey = (s: string): s is ShardKey => /^[0-9a-z-]{1,16}$/.test(s);

export type Json = null | boolean | number | string | readonly Json[] | { readonly [k: string]: Json };

// ---------- Register layer ----------

/** Last-writer-wins register. The higher stamp wins. */
export type Reg<T> = readonly [value: T, stamp: Hlc];

/** Every record carries an immutable `kind`. Every other field is a mutable register. */
export type Rec = { readonly kind: string };

/**
 * Replicated form of one item. Distributes over the record union, so a bookmark folder has no `url`
 * register and a url bookmark always has one. `deleted` is a register too, so a later delete beats an
 * earlier edit and a later restore beats an earlier delete.
 */
export type Entry<R extends Rec> = R extends unknown
  ? {
      readonly kind: R['kind'];
      readonly fields: { readonly [K in Exclude<keyof R, 'kind'>]: Reg<R[K]> };
      readonly deleted: Reg<boolean>;
    }
  : never;

/** Stamped state of one data type, tombstones included. The unit a device publishes. */
export type Replica<R extends Rec> = ReadonlyMap<ItemId, Entry<R>>;

/** Plain state with no stamps. What a profile shows, and what `materialize` produces. */
export type Live<R extends Rec> = ReadonlyMap<ItemId, R>;

// ---------- The DataType contract ----------
// A data type supplies domain knowledge only. Merge, stamping, GC, diff, and the wire format are generic
// (crdt.ts, store-format.ts). Method syntax is deliberate. Parameter bivariance lets DataType<Bookmark>
// sit in a Registry of DataType<Rec> without `any`. The engine never feeds one type's values to another.

export interface DataType<R extends Rec> {
  /** Bumped on an incompatible record change. A device refuses state files from a newer version. */
  readonly version: number;

  /**
   * CHANGED. Which shard a record lives in. Pure and stable for a record's lifetime, so a record never
   * migrates between files. Items that reference each other (a bookmark and its parent) must share a shard.
   */
  shardOf(record: R): ShardKey;

  /**
   * CHANGED. True once a record has aged out of the type's sync window (history: older than 90 days).
   * The engine drops expired records from observed, applied, and every replica before merging, and a
   * device deletes its own files for shards that are wholly expired. Aging out is never a delete, so it
   * never produces a tombstone. Bookmarks: always false.
   */
  expired(record: R, nowMs: number): boolean;

  /** Store boundary. Field values arrive untrusted. `null` drops the entry, never the whole file. */
  parseRecord(raw: { readonly kind: unknown; readonly [field: string]: unknown }): R | null;

  /**
   * Map local items onto existing synced items with equal content, so a profile that already holds
   * the data does not duplicate it. One recovery path for first join, reinstall, and a crash mid-apply.
   */
  adopt(input: AdoptInput<R>): Adoption<R>;

  /** Pure, stamp-free repair after a merge (bookmarks re-home orphans and break move cycles). */
  normalize(live: Live<R>, dead: Live<R>): Live<R>;

  /** One human line for reports and `--dry-run`. */
  label(record: R): string;
}

export type AdoptInput<R extends Rec> = {
  /** What the profile shows, keyed by the adapter's ids. */
  readonly local: Live<R>;
  /** Synced items the profile does not have and did not just delete. The only adoption targets. */
  readonly unclaimed: Live<R>;
  /** Ids already synced. They anchor their children but are never re-mapped. */
  isKnown(id: ItemId): boolean;
};

export type Adoption<R extends Rec> = {
  /** `local` with adopted ids (and references to them, such as a bookmark's parent) rewritten. */
  readonly live: Live<R>;
  /** local id to synced id. The engine hands it to the adapter, which owns id mapping. */
  readonly aliases: ReadonlyMap<ItemId, ItemId>;
};
