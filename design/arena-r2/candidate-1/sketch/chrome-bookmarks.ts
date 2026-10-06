// Bookmarks through chrome.bookmarks. Owns the ItemId <-> chrome id map (round 1: "id mapping belongs to
// the adapter, never the engine"). The API exposes no guid and rejects a caller-chosen id (P2), so the map
// is the only link between a synced item and a node in this profile.
import type { Brand, ItemId, Live } from './model.ts';
import { ROOTS, placeChildren, type Bookmark, type Location } from './bookmarks.ts';
import type { Channel } from './ports.ts';
import { idMap } from './local.ts';

/** chrome.bookmarks node id. Per profile; stable across restarts; reassigned only if Chromium repairs a corrupt file. */
export type ChromeId = Brand<string, 'ChromeId'>;
export const isChromeId = (s: string): s is ChromeId => /^\d+$/.test(s);

/**
 * Roots map by `folderType` (Chrome 134+, observed in Helium as "bookmarks-bar"), not by the ids '1'/'2'/'3'.
 * Roots are never in the id map, never created, renamed, or removed. Managed folders are skipped entirely.
 * Exhaustive over chrome's FolderType, so a new folder type fails to compile until it is mapped or skipped.
 */
type SyncedFolderType = Exclude<NonNullable<chrome.bookmarks.BookmarkTreeNode['folderType']>, 'managed'>;
const ROOT_BY_FOLDER_TYPE = { 'bookmarks-bar': ROOTS.bar, other: ROOTS.other, mobile: ROOTS.mobile } as const satisfies {
  readonly [K in SyncedFolderType]: ItemId;
};

export function chromeBookmarks(): Channel<Bookmark> {
  return {
    /*
     * getTree(); walk from the three roots, skipping `unmodifiable` nodes.
     * chrome id -> ItemId through idMap. A node with no entry gets crypto.randomUUID() as its ItemId, and
     * the entry is saved before read returns, so a crash never mints a second id for the same node.
     * Child indexes become positions through placeChildren(children, previous), which keeps previous
     * positions for children still in order, so an untouched folder never reads as reordered.
     */
    async read(_previous) {
      throw new Error('not implemented');
    },

    /** Rewrite map rows: the node read as `from` is synced item `to`. The minted `from` id is discarded. */
    async bind(_aliases) {
      throw new Error('not implemented');
    },

    /*
     * ops = planApply(current, target); run in order:
     *   creates     parents before children; save each new (chrome id, ItemId) row right after its create
     *   updates     title / url
     *   moves       per folder, children in target position order, move(id, { parentId, index }) where they differ
     *   removes     children before parents; remove(), or removeTree() for a folder whose subtree all goes
     * Any throw -> 'interrupted'. Our own calls fire bookmarks events, which schedule one more cycle; it reads
     * observed == applied and does nothing.
     */
    async apply(_change) {
      throw new Error('not implemented');
    },
  };
}

export type BookmarkOp =
  | { readonly op: 'create'; readonly id: ItemId; readonly record: Bookmark }
  | { readonly op: 'update'; readonly id: ItemId; readonly title: string; readonly url: string | null }
  | { readonly op: 'move'; readonly id: ItemId; readonly to: Location }
  | { readonly op: 'remove'; readonly id: ItemId; readonly subtree: boolean };

/** Pure. The ordered API calls that turn `current` into `target`. Tested without a browser. */
export function planApply(_current: Live<Bookmark>, _target: Live<Bookmark>): readonly BookmarkOp[] {
  throw new Error('not implemented');
}
