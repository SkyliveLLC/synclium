// Domain vocabulary shared by every module: branded ids, the HLC stamp, the register layer, and the two
// data-type models. Pure types plus brand predicates. No chrome.*, no File System Access, no wire shapes.
//
// A data type is either a RegisterType (items anyone may edit, merged per field) or a LogType (immutable facts
// with one author, merged by union). The engine runs one function per model (register-cycle.ts, log-cycle.ts),
// so a third type plugs into one of two existing cycles.

declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

/** One installation on one machine. Minted by LocalState, never reused after an idle rejoin. */
export type DeviceId = Brand<string, 'DeviceId'>;

/**
 * Cross-device identity of one register item. A uuid minted by the bookmark channel, or adopted from a peer.
 * Never a chrome bookmark id (per profile) and never a Chromium guid (the API hides it, P2).
 */
export type ItemId = Brand<string, 'ItemId'>;

/**
 * Hybrid logical clock stamp `<wall ms, base36, 9>.<counter, base36, 4>.<DeviceId>`. Fixed width, so plain
 * string comparison is the total order. The DeviceId suffix makes ties impossible and names the author,
 * which tombstone GC relies on. Minted only by `tick` in crdt.ts.
 */
export type Hlc = Brand<string, 'Hlc'>;
export type HlcState = { readonly wall: number; readonly counter: number };

/** UTC calendar day `yyyy-mm-dd`. The shard unit of every log type, so all devices cut days at one instant. */
export type DayKey = Brand<string, 'DayKey'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ITEM = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/;
const HLC = /^[0-9a-z]{9}\.[0-9a-z]{4}\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// Predicates are the only way to obtain a brand, so no module needs a cast.
export const isDeviceId = (s: string): s is DeviceId => UUID.test(s);
export const isItemId = (s: string): s is ItemId => ITEM.test(s);
export const isHlc = (s: string): s is Hlc => HLC.test(s);
export const isDayKey = (s: string): s is DayKey => DAY.test(s);

export const DAY_MS = 86_400_000;

export function dayOf(t: number): DayKey {
  const day = new Date(t).toISOString().slice(0, 10);
  if (!isDayKey(day)) throw new Error(`not a day: ${day}`);
  return day;
}

/** [start, end) of a UTC day in ms. */
export function dayRange(day: DayKey): readonly [number, number] {
  const start = Date.parse(`${day}T00:00:00.000Z`);
  return [start, start + DAY_MS];
}

export function shiftDay(day: DayKey, days: number): DayKey {
  return dayOf(dayRange(day)[0] + days * DAY_MS);
}

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

/** Stamped state of one register type, tombstones included. The unit a device publishes. */
export type Replica<R extends Rec> = ReadonlyMap<ItemId, Entry<R>>;

/** Plain state with no stamps. What the profile shows, and what `materialize` produces. */
export type Live<R extends Rec> = ReadonlyMap<ItemId, R>;

// ---------- The two models ----------

/** Store path segment, `[a-z][a-z0-9-]*`. Names the type's file (register) or folder (log). */
type TypeName = 'bookmarks' | 'history';

/**
 * Items any device may edit. Merge, stamping, GC, and the wire format are generic (crdt.ts); a register
 * type supplies only domain knowledge.
 */
export interface RegisterType<R extends Rec> {
  readonly model: 'register';
  readonly name: TypeName;
  /** Bumped on an incompatible record change. A device refuses state files from a newer version. */
  readonly version: number;
  /** Store boundary. Field values arrive untrusted. `null` drops the entry, never the whole file. */
  parseRecord(raw: { readonly kind: unknown; readonly [field: string]: unknown }): R | null;
  /**
   * Map local items onto synced items with equal content, so a profile that already holds the data does not
   * duplicate it. One recovery path for first join, reinstall, and a crash mid-apply.
   */
  adopt(input: AdoptInput<R>): Adoption<R>;
  /** Pure, stamp-free repair after a merge (bookmarks re-home orphans and break move cycles). */
  normalize(live: Live<R>, dead: Live<R>): Live<R>;
  /**
   * Ids a record points at (a bookmark's parent). A tombstone that a live record still references stays out
   * of GC, so `normalize` can keep walking it; without this an orphan's re-homing would change when GC ran.
   */
  references(record: R): readonly ItemId[];
  label(record: R): string;
}

export type AdoptInput<R extends Rec> = {
  readonly local: Live<R>;
  /** Every live synced item. Items the profile adds are placed among these, so a join never mints a position a peer already holds. */
  readonly synced: Live<R>;
  /** Synced items the profile does not have and did not just delete. The only adoption targets. */
  readonly unclaimed: Live<R>;
  /** Ids already synced. They anchor their children but are never re-mapped. */
  isKnown(id: ItemId): boolean;
};

export type Adoption<R extends Rec> = {
  /** `local` with adopted ids (and references to them, such as a bookmark's parent) rewritten. */
  readonly live: Live<R>;
  /** local id to synced id. The engine hands it to the channel, which owns id mapping. */
  readonly aliases: ReadonlyMap<ItemId, ItemId>;
};

/** A fact one device observed at wall time `t` (ms since epoch). Nobody edits it. */
export type Ev = { readonly t: number };

/** The identity of one event across devices. Two devices holding the same key hold the same fact. */
export type EventKey = Brand<string, 'EventKey'>;

/**
 * Immutable facts with exactly one author. A device publishes only its own events, one shard per UTC day;
 * readers take the union. No stamps, no tombstones, no merge. A local delete leaves the author's shard
 * when the day is re-derived, and readers replace the shard whole.
 */
export interface LogType<E extends Ev> {
  readonly model: 'log';
  readonly name: TypeName;
  readonly version: number;
  /** Store boundary. `null` drops the event, never the shard. */
  parseEvent(raw: unknown): E | null;
  key(event: E): EventKey;
  /** Authors delete older shards; readers drop older events. History: 90, Chromium's own expiry. */
  readonly retentionDays: number;
  label(event: E): string;
}
