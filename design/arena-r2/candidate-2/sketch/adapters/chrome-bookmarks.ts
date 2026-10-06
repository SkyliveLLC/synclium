// RegisterChannel<Bookmark> over chrome.bookmarks. The only module that knows BookmarkTreeNode and the id map.
//
// Identity. chrome.bookmarks exposes a per-profile integer id and no guid (P2). The adapter keeps a permanent
// map chromeId <-> ItemId in IndexedDB (store `bookmarkIds`). Rules:
//  - Root nodes are found by `folderType` ('bookmarks-bar' | 'other' | 'mobile') and pinned to ROOTS. Managed
//    folders and the invisible root are not records.
//  - A node with no map entry gets `mintItemId()` and the entry is written during `read`. If the engine then
//    adopts it, `bind` rewrites the entry to the synced id; the minted id was never published, so no cleanup.
//  - A map entry whose chromeId no longer exists (profile restored from backup) is dropped on read; the
//    ItemId becomes unclaimed and is re-adopted by content or re-created.
//  - A node created by `apply` gets its entry written in the same step, right after `chrome.bookmarks.create`
//    resolves. A crash between create and map write leaves a node with no entry; the next read mints an id,
//    adoption pairs it with the synced item by content, and the duplicate never forms.
import type { ItemId, Live } from '../model.ts';
import type { RegisterChannel } from '../ports.ts';
import type { Bookmark } from '../types/bookmarks.ts';

export type ChromeId = string;

/** The id map, adapter-private, in IndexedDB. Both directions are one object store with two indexes. */
export interface IdMap {
  itemOf(chromeId: ChromeId): Promise<ItemId | null>;
  chromeOf(item: ItemId): Promise<ChromeId | null>;
  set(pairs: ReadonlyMap<ChromeId, ItemId>): Promise<void>;
  deleteChrome(ids: readonly ChromeId[]): Promise<void>;
  all(): Promise<ReadonlyMap<ChromeId, ItemId>>;
}

/**
 * read(previous): getTree once, walk from the three roots, resolve ids through the map, mint for unknowns,
 *   derive positions with `placeChildren(children, previous)` from the child indexes the API gives.
 * bind(aliases): rewrite map entries from minted ids to synced ids.
 * apply({ current, target }): diffLive, then creates top-down (parents before children), moves, updates,
 *   removes bottom-up. `chrome.bookmarks.create` returns the new node; its id is mapped before the next call.
 *   An API rejection (bad URL scheme, moving a folder into itself after a bad merge) is collected per item,
 *   never thrown; the engine reports `partial` and retries next cycle because the fold rule recomputes the diff.
 *   Our own writes fire chrome.bookmarks.on* events; background.ts ignores events while `applying` is true.
 */
export function chromeBookmarksChannel(_ids: IdMap): RegisterChannel<Bookmark> & { readonly applying: () => boolean } {
  throw new Error('not implemented');
}

/** Boundary: the API's tree to Live<Bookmark> plus the children lists `placeChildren` needs. Pure given the map. */
function fromTree(
  _roots: readonly chrome.bookmarks.BookmarkTreeNode[],
  _ids: ReadonlyMap<ChromeId, ItemId>,
  _previous: Live<Bookmark> | null,
): { readonly live: Live<Bookmark>; readonly minted: ReadonlyMap<ChromeId, ItemId> } {
  throw new Error('not implemented');
}
