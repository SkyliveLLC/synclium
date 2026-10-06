// Domain vocabulary shared by every module. Runtime-agnostic: no node:*, no chrome.* values.
// Everything here is either a branded primitive, a stored shape, or the DataType contract.

declare const brand: unique symbol;
/** Nominal brand. A branded value is minted only by the parser or constructor named in its doc. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

/** One Helium profile on one machine. Minted once by the extension (crypto.randomUUID), kept in chrome.storage.local. */
export type DeviceId = Brand<string, 'DeviceId'>;
/** Cross-device identity of one item. Minted by the engine (or a well-known constant for bookmark roots). */
export type SyncId = Brand<string, 'SyncId'>;
/** Browser-assigned id (e.g. chrome.bookmarks "42"). Valid inside one profile only; never written to the store. */
export type LocalId = Brand<string, 'LocalId'>;
/**
 * Hybrid logical clock stamp `<wall ms, base36, 9>.<counter, base36, 4>.<DeviceId>`.
 * Plain string comparison is the total order; the DeviceId suffix makes cross-device ties impossible.
 * Minted only by `tick` in crdt.ts or parsed by storeFormat.ts.
 */
export type Stamp = Brand<string, 'Stamp'>;

export type Json = null | boolean | number | string | readonly Json[] | { readonly [k: string]: Json };

/** A last-writer-wins register. */
export type Reg<T> = readonly [value: T, at: Stamp];

/** Every record of every data type carries an immutable `kind`; all other fields are mutable registers. */
export type Rec = { readonly kind: string };

/**
 * Stored form of one item: one register per mutable field, plus a deletion register.
 * Distributes over the record union, so a bookmark folder has no `url` register and a url always has one.
 */
export type Entry<R extends Rec> = R extends unknown
  ? {
      readonly kind: R['kind'];
      readonly fields: { readonly [K in Exclude<keyof R, 'kind'>]: Reg<R[K]> };
      readonly deleted: Reg<boolean>;
    }
  : never;

/** Stamped state of one data type as one device knows it. Tombstones included. */
export type Replica<R extends Rec> = ReadonlyMap<SyncId, Entry<R>>;
/** Materialized state: tombstones dropped, type invariants repaired (see MergeType.normalize). */
export type Live<R extends Rec> = ReadonlyMap<SyncId, R>;
/** Which browser item each synced item is on this device. The reverse direction is derived, never stored. */
export type IdMap = ReadonlyMap<SyncId, LocalId>;

// ---------- Browser half of a data type (runs inside the companion extension) ----------

/** Browser-side operations. Args and results cross native messaging as JSON. */
export type Facet = { readonly [op: string]: (args: never) => Promise<Json> };
/** Host-side view of a Facet. Results are `unknown` on purpose: the host parses them (process boundary). */
export type Remote<F extends Facet> = { readonly [K in keyof F]: (args: Parameters<F[K]>[0]) => Promise<unknown> };
/** A chrome event whose firing means "this type may have changed locally". Trigger only; diffs are snapshot-based. */
export type ChangeEvent = { addListener(listener: () => void): void };

export type BrowserHalf<F extends Facet> = (api: typeof chrome) => { readonly ops: F; readonly changes: readonly ChangeEvent[] };

// ---------- The registry contract ----------
// Method syntax (not arrow properties) is deliberate: parameters stay bivariant, so heterogeneous entries
// fit `AnyDataType` without `any`. The engine never feeds one entry's output into another entry.

interface Common<R extends Rec, F extends Facet> {
  readonly name: string;
  /** Chrome permissions this type needs. The extension manifest is generated from the registry. */
  readonly permissions: readonly chrome.runtime.ManifestPermission[];
  readonly browser: BrowserHalf<F>;
  /** Store/bridge boundary: build a record from untrusted field values. `undefined` = reject the entry. */
  parse(raw: { readonly kind: unknown; readonly [field: string]: unknown }): R | undefined;
}

/** Two-way type: every device converges on one merged state and writes it into its browser. */
export interface MergeType<R extends Rec, F extends Facet> extends Common<R, F> {
  readonly mode: 'merge';
  /**
   * Read the browser and express it in sync space. Local items missing from `ctx.ids` are adopted onto
   * `ctx.known` by content (first join, and recovery after a crash mid-realize), otherwise get `ctx.mint()`.
   */
  observe(remote: Remote<F>, ctx: ObserveContext<R>): Promise<Observed<R>>;
  /** Pure. Repair type invariants after a merge (bookmarks: re-home orphans, break cycles). */
  normalize(live: Live<R>, dead: Live<R>): Live<R>;
  /** Drive the browser from `observed` to `target`. Per-item failures are returned, never thrown. */
  realize(remote: Remote<F>, target: Live<R>, observed: Observed<R>): Promise<Realized>;
}

/**
 * One-way type: each device publishes what it has; others read it, nobody writes it into a browser.
 * Fits open tabs, extension list, read-only history. No v1 entry uses it; it is here so adding one is one entry.
 */
export interface PublishType<R extends Rec, F extends Facet> extends Common<R, F> {
  readonly mode: 'publish';
  observe(remote: Remote<F>): Promise<Live<R>>;
}

export type DataType<R extends Rec, F extends Facet> = MergeType<R, F> | PublishType<R, F>;
export type AnyDataType = DataType<Rec, Facet>;
export type RecordOf<D> = D extends DataType<infer R, infer _F> ? R : never;
export type FacetOf<D> = D extends DataType<infer _R, infer F> ? F : never;

export type ObserveContext<R extends Rec> = {
  readonly ids: IdMap;
  /** Last applied view overlaid on the merged remote state: what an unmapped local item may already be. */
  readonly known: Live<R>;
  readonly mint: () => SyncId;
};
export type Observed<R extends Rec> = { readonly live: Live<R>; readonly ids: IdMap };
export type Realized = { readonly ids: IdMap; readonly failed: readonly { readonly id: SyncId; readonly error: string }[] };
