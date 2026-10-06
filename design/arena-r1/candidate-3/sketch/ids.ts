// Branded primitives and the hybrid logical clock. Pure; no I/O.
declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type VaultId = Brand<string, "VaultId">;
export type DeviceId = Brand<string, "DeviceId">;
/** Stable identity of a synced item across devices (for bookmarks: the Chromium guid or a minted uuid). */
export type ItemId = Brand<string, "ItemId">;
/** Opaque, slash-separated, [a-z0-9._-] segments only. Built by `keys` in envelope.ts, never by hand. */
export type StoreKey = Brand<string, "StoreKey">;
export type TypeId = Brand<string, "TypeId">;
export type ProfileId = Brand<string, "ProfileId">;

/**
 * `<wall base36, 9>.<counter base36, 4>.<deviceId>`. Lexicographic order == causal-ish order,
 * so registers merge with plain string comparison. Skew can flip LWW; accepted (see DESIGN).
 */
export type Hlc = Brand<string, "Hlc">;

export const Hlc = {
  /** Next stamp strictly greater than `prev` and every stamp in `seen`; `now` is injected wall time (ms). */
  tick(_input: { now: number; device: DeviceId; prev: Hlc | null; seen: readonly Hlc[] }): Hlc {
    throw new Error("not implemented");
  },
  compare(a: Hlc, b: Hlc): -1 | 0 | 1 {
    return a < b ? -1 : a > b ? 1 : 0;
  },
} as const;

/** Last-writer-wins register. The only merge primitive the bookmark type needs. */
export type Reg<T> = readonly [value: T, stamp: Hlc];
export function maxReg<T>(a: Reg<T>, b: Reg<T>): Reg<T> {
  return a[1] >= b[1] ? a : b;
}
