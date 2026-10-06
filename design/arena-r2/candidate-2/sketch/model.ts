// Domain vocabulary shared by every module. Brands, the HLC stamp, the register layer, and the two
// DataType models. Pure types plus brand predicates. No chrome.*, no fetch, no wire shapes.
//
// Round 1 reused as-is, plus one addition: a DataType is now either a `registers` type (bookmarks, p3's
// merge model) or a `log` type (history: author-owned facts, set union, sharded by day). The engine
// switches on `model` once per type.

declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

/** One installation on one machine. Minted by LocalState, never reused after an idle rejoin. */
export type DeviceId = Brand<string, 'DeviceId'>;

/**
 * Cross-device identity of one synced item. A UUID minted by the adapter that first sees the item.
 * Round 1 used the Chromium guid; chrome.bookmarks does not expose it (P2), so the adapter owns a
 * permanent ItemId <-> chrome id map instead.
 */
export type ItemId = Brand<string, 'ItemId'>;

/**
 * Hybrid logical clock stamp `<wall ms, base36, 9>.<counter, base36, 4>.<DeviceId>`. Fixed width, so plain
 * string comparison is the total order. Minted only by `tick` in crdt.ts.
 */
export type Hlc = Brand<string, 'Hlc'>;
export type HlcState = { readonly wall: number; readonly counter: number };

/** UTC calendar day `YYYY-MM-DD`. The shard unit for log types. */
export type ShardId = Brand<string, 'ShardId'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HLC = /^[0-9a-z]{9}\.[0-9a-z]{4}\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHARD = /^\d{4}-\d{2}-\d{2}$/;

// Predicates are the only way to obtain a brand, so no module needs a cast.
export const isDeviceId = (s: string): s is DeviceId => UUID.test(s);
export const isItemId = (s: string): s is ItemId => UUID.test(s);
export const isHlc = (s: string): s is Hlc => HLC.test(s);
export const isShardId = (s: string): s is ShardId => SHARD.test(s);

/** `crypto.randomUUID()` is the only minting path. Adapters call it for items with no map entry. */
export function mintItemId(): ItemId {
  const id = crypto.randomUUID();
  if (!isItemId(id)) throw new Error('randomUUID produced a non-uuid');
  return id;
}

export type Json = null | boolean | number | string | readonly Json[] | { readonly [k: string]: Json };

// ---------- Register layer (bookmarks) ----------

/** Last-writer-wins register. The higher stamp wins. */
export type Reg<T> = readonly [value: T, stamp: Hlc];

/** Every record carries an immutable `kind`. Every other field is a mutable register. */
export type Rec = { readonly kind: string };

/** Replicated form of one item. Distributes over the record union, so a folder has no `url` register. */
export type Entry<R extends Rec> = R extends unknown
  ? {
      readonly kind: R['kind'];
      readonly fields: { readonly [K in Exclude<keyof R, 'kind'>]: Reg<R[K]> };
      readonly deleted: Reg<boolean>;
    }
  : never;

/** Stamped state of one register type, tombstones included. The unit a device publishes. */
export type Replica<R extends Rec> = ReadonlyMap<ItemId, Entry<R>>;

/** Plain state with no stamps. What the browser shows, and what `materialize` produces. */
export type Live<R extends Rec> = ReadonlyMap<ItemId, R>;

export interface RegisterType<R extends Rec> {
  readonly model: 'registers';
  /** Bumped on an incompatible record change. A device refuses files from a newer version. */
  readonly version: number;
  /** Store boundary. Field values arrive untrusted. `null` drops the entry, never the whole file. */
  parseRecord(raw: { readonly kind: unknown; readonly [field: string]: unknown }): R | null;
  /** Map local items onto synced items with equal content. One recovery path for first join, reinstall, and a crash mid-apply. */
  adopt(input: AdoptInput<R>): Adoption<R>;
  /** Pure, stamp-free repair after a merge (bookmarks re-home orphans and break move cycles). */
  normalize(live: Live<R>, dead: Live<R>): Live<R>;
  /** One human line for the popup's change list. */
  label(record: R): string;
}

export type AdoptInput<R extends Rec> = {
  readonly local: Live<R>;
  /** Synced items the browser does not have and did not just delete. The only adoption targets. */
  readonly unclaimed: Live<R>;
  isKnown(id: ItemId): boolean;
};

export type Adoption<R extends Rec> = {
  readonly live: Live<R>;
  /** local id to synced id. The engine hands it to the adapter, which owns id mapping. */
  readonly aliases: ReadonlyMap<ItemId, ItemId>;
};

// ---------- Log layer (history) ----------

/**
 * An event is a fact one device observed at wall time `t` (ms epoch). Nobody edits it, so it needs no
 * stamp and no tombstone. Two devices never produce the same event, so merge is set union.
 */
export type Ev = { readonly t: number };

export interface LogType<E extends Ev> {
  readonly model: 'log';
  readonly version: number;
  /** Store boundary. `null` drops the event, never the shard. */
  parseEvent(raw: unknown): E | null;
  /** Dedupe key within one author's shard (history: url + t). */
  key(event: E): string;
  /** Author shards older than this are deleted by the author. Chromium itself expires history at 90 days. */
  readonly retentionDays: number;
  label(event: E): string;
}

/** The calendar day an event belongs to. Pure, so every device shards identically. */
export function shardOf(_t: number): ShardId {
  throw new Error('not implemented');
}

export type DataType = RegisterType<Rec> | LogType<Ev>;
