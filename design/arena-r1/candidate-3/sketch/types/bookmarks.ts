// v1 data type. Pure functions over domain types; Chromium JSON never appears here.
// Merge model: the p3 winner. Per-item LWW registers stamped with HLC, delete beats concurrent edit,
// orphans re-homed to the nearest live ancestor, fractional string positions, content adoption on first join.
import type { Hlc, ItemId, Reg } from "../ids.ts";
import type { MergedType } from "../registry.ts";

declare const pos: unique symbol;
/** Fractional index within a folder; string order == display order. Minted between neighbours, never renumbered. */
export type Position = string & { readonly [pos]: true };

/** What the profile contains right now. Flat, roots have parent null (bookmark_bar, other, synced). */
export type BookmarkTree = ReadonlyMap<ItemId, BookmarkNode>;
export type BookmarkNode =
  | { kind: "folder"; parent: ItemId | null; position: Position; title: string }
  | { kind: "url"; parent: ItemId; position: Position; title: string; url: string };

/** One item as replicated: a register per mutable facet, so a rename and a move by different devices both survive. */
export interface BookmarkRecord {
  kind: "url" | "folder";
  title: Reg<string>;
  url?: Reg<string>;
  where: Reg<readonly [parent: ItemId | null, position: Position]>;
  deleted: Reg<boolean>;
}
export type BookmarkState = Readonly<Record<ItemId, BookmarkRecord>>;

export type BookmarkChange =
  | { op: "add"; id: ItemId; node: BookmarkNode }
  | { op: "rename"; id: ItemId; title: string }
  | { op: "retarget"; id: ItemId; url: string }
  | { op: "move"; id: ItemId; parent: ItemId | null; position: Position }
  | { op: "remove"; id: ItemId };

export const bookmarks: MergedType<"bookmarks", BookmarkTree, BookmarkState, BookmarkChange> = {
  kind: "merged",
  id: "bookmarks",
  version: 1,
  parseState: (_raw) => { throw new Error("not implemented"); },
  empty: () => ({}),
  merge: (_states) => {
    // per item: maxReg on each facet (stamp string compare). Commutative/associative/idempotent by construction.
    throw new Error("not implemented");
  },
  observe: (_i) => {
    // applied === null: adoptByContent(current, materialize(state)) keyed (mapped parent, kind, title, url),
    //   top-down so a matched folder carries its children; then register unmatched local nodes.
    // else: compare current vs applied: changed facets get `stamp`; ids gone from current get deleted=[true, stamp].
    // Positions: keep applied position for nodes that did not move; interpolate the rest between neighbours.
    // Throw SuspiciousChange if current is empty/loses >50% of >=20 items.
    throw new Error("not implemented");
  },
  materialize: (_state) => {
    // live = !deleted; rescue orphans (parent dead/missing -> nearest live ancestor, else "other" root).
    throw new Error("not implemented");
  },
  diff: (_from, _to) => { throw new Error("not implemented"); },
  describe: (_c) => { throw new Error("not implemented"); },
  gc: (_state, _ackedBy) => {
    // drop records with deleted=[true, s] where s <= ackedBy
    throw new Error("not implemented");
  },
};
