// Reused from round 1 unchanged (types/bookmarks.ts). Bookmarks as a data type: what a record is, how to
// adopt by content, how to repair a tree after a merge. chrome.bookmarks never appears here (see chrome-bookmarks.ts).
import { isItemId, type Brand, type DataType, type ItemId, type Live } from './model.ts';

/** Fractional index. String order is display order within a folder. Minted between neighbours, never renumbered. */
export type Position = Brand<string, 'Position'>;

/** Parent and position share one register, so concurrent moves never split a node's parent from its order. */
export type Location = { readonly parent: ItemId; readonly pos: Position };

export type Bookmark =
  | { readonly kind: 'folder'; readonly title: string; readonly location: Location }
  | { readonly kind: 'url'; readonly title: string; readonly url: string; readonly location: Location };

function root(guid: string): ItemId {
  if (!isItemId(guid)) throw new Error(`bad root guid ${guid}`);
  return guid;
}

/**
 * Chromium's well-known permanent folder guids. Roots are not records. They are never created, renamed,
 * or deleted, and they are the same on every device, so they need no adoption.
 */
export const ROOTS = {
  bar: root('0bc5d13f-2cba-5d74-951f-3f233fe6c908'),
  other: root('82b081ec-3dd3-529c-8475-ab6c344590dd'),
  mobile: root('4cf2e351-0e85-532b-bb37-df045d8f8d0f'),
} as const;

export const bookmarks: DataType<Bookmark> = {
  version: 1,

  parseRecord(_raw) {
    // folder: { title, location }. url: { title, url, location }. Anything else returns null.
    throw new Error('not implemented');
  },

  adopt(_input) {
    // p3 adoptGuids. Top-down from the roots, so a matched folder carries its children.
    // Key = (already-mapped parent, kind, title, url). First unused unclaimed candidate wins.
    // Twin siblings with equal content pair in order. A wrong pairing is harmless because content is equal.
    throw new Error('not implemented');
  },

  normalize(_live, _dead) {
    // Pure and stamp-free, so every device derives the same tree from the same merge.
    // 1. Break move cycles. The cycle member with the smallest ItemId goes under ROOTS.other.
    // 2. Re-home orphans under the nearest live ancestor, walking `dead` locations, else ROOTS.other.
    throw new Error('not implemented');
  },

  label(_b) {
    throw new Error('not implemented');
  },
};

/**
 * Browser order to stable positions. Keeps `previous` positions for the longest run of children still in
 * order and mints keys between them for the rest. Without this, every read looks like a reorder of the folder.
 * Used by adapters, which see only child indexes.
 */
export function placeChildren(
  _children: ReadonlyMap<ItemId, readonly ItemId[]>,
  _previous: Live<Bookmark> | null,
): ReadonlyMap<ItemId, Location> {
  throw new Error('not implemented');
}
