// The extension point. Adding a data type = writing one object that satisfies MergedType or
// ObservedType and adding it to the registry in index.ts. Nothing else in core changes.
// Methods are declared with method syntax on purpose: bivariance lets a concrete
// MergedType<"bookmarks", Tree, State, Change> be stored in a Registry without `any`.
import type { Hlc, TypeId } from "./ids.ts";

/**
 * Data that converges to one shared value across devices (bookmarks, later history).
 *   Local  = the profile's current content, in domain terms (never Chromium JSON or extension messages).
 *   State  = the replicated CRDT-ish state each device publishes (full merged state, own file).
 *   Change = one human-meaningful difference between two Locals (drives apply and reports).
 */
export interface MergedType<Id extends string = string, Local = unknown, State = unknown, Change = unknown> {
  readonly kind: "merged";
  readonly id: Id;
  /** Bumped on incompatible State changes. Devices refuse (and report) newer versions than they know. */
  readonly version: number;
  /** Boundary: untrusted decrypted JSON -> State. Throws on malformed input. */
  parseState(raw: unknown): State;
  empty(): State;
  /** Commutative, associative, idempotent. This property is what makes per-device files conflict-free. */
  merge(states: readonly State[]): State;
  /**
   * Fold what changed locally since `applied` into the merged `state`, stamped with `stamp`.
   * `applied === null` means first join: adopt by content so existing local items do not duplicate.
   * May throw SuspiciousChange (e.g. local read is empty or lost >50% of items); engine surfaces it
   * and publishes nothing for this type until `--force`.
   */
  observe(input: { state: State; applied: Local | null; current: Local; stamp: Hlc }): State;
  materialize(state: State): Local;
  diff(from: Local, to: Local): Change[];
  describe(change: Change): string;
  /** Drop tombstones every live device has acknowledged. `ackedBy` is the min over live devices. */
  gc(state: State, ackedBy: Hlc): State;
}

/**
 * Data every device only publishes about itself and others only read (open tabs, extension list).
 * No merge, no apply, no conflicts: the store's one-writer-per-key rule is the whole algorithm.
 */
export interface ObservedType<Id extends string = string, Snapshot = unknown> {
  readonly kind: "observed";
  readonly id: Id;
  readonly version: number;
  parseSnapshot(raw: unknown): Snapshot;
}

export type DataType = MergedType | ObservedType;
export type Registry = { readonly [id: string]: DataType };

export class SuspiciousChange extends Error {
  readonly type: TypeId;
  constructor(type: TypeId, message: string) {
    super(message);
    this.type = type;
  }
}

export function defineRegistry<const R extends Registry>(r: R): R {
  return r;
}

// Everything below is derived from the registry; adapters and reports adapt automatically.
export type LocalOf<T> = T extends MergedType<string, infer L, unknown, unknown> ? L : T extends ObservedType<string, infer S> ? S : never;
export type ChangeOf<T> = T extends MergedType<string, unknown, unknown, infer C> ? C : never;
export type MergedIds<R extends Registry> = { [K in keyof R]: R[K] extends MergedType ? K : never }[keyof R] & string;
