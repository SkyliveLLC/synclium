// Bookmarks channel over chrome.bookmarks. The one place that knows the extension API has no guid.
//
// Identity (the ItemId <-> chrome id map). chrome ids are local, numeric, monotonic, and never reused.
//   - A node THIS device created or first saw: its ItemId is derived, `deriveId(device, chromeId)`. No state,
//     so it needs no map entry and survives a crash before anything is saved.
//   - A node created HERE by applying a REMOTE item: the ItemId came from the remote and the chrome id from
//     `bookmarks.create`. Only these need a persisted entry, in `IdMap`.
//   - Roots are matched by `folderType` ('bookmarks-bar' | 'other' | 'mobile') to the ROOTS guids.
//   Lose the map (extension data cleared) and nothing breaks: the remote-origin nodes come back as local items
//   with derived ids, and first-join adoption by (parent, kind, title, url) re-binds them (`bind`). Same single
//   recovery path as round 1. A crash between `create` and the map write takes the same path.
import type { DeviceId, ItemId } from '../model.ts';
import type { WriteChannel } from '../ports.ts';
import type { Bookmark } from '../types/bookmarks.ts';

/** Remote-origin ids only. Adapter-private IndexedDB database `helium-sync-bookmark-ids`. The engine never sees it. */
export interface IdMap {
  chromeId(id: ItemId): Promise<string | null>;
  itemId(chromeId: string): Promise<ItemId | null>;
  put(pairs: ReadonlyMap<ItemId, string>): Promise<void>;
  delete(ids: readonly ItemId[]): Promise<void>;
}

export function idbIdMap(): IdMap {
  throw new Error('not implemented');
}

/** Stateless and identical on every call, so a rerun after a kill derives the same id. */
export function deriveId(_device: DeviceId, _chromeId: string): ItemId {
  throw new Error('not implemented');
}

export type ChromeBookmarksDeps = {
  readonly device: () => Promise<DeviceId>;
  readonly ids: IdMap;
  /** Self-imposed ceiling per apply call, under chrome's 100-per-minute sustained limit. */
  readonly maxWritesPerApply: number;
};

export function chromeBookmarks(_deps: ChromeBookmarksDeps): WriteChannel<Bookmark> {
  // read(previous):  bookmarks.getTree() -> Live<Bookmark> with ids from IdMap or deriveId; roots map to ROOTS;
  //                  child order -> positions through placeChildren(children, await previous('all')).
  //                  Skips `unmodifiable` managed folders.
  // bind(aliases):   IdMap.put(local chrome id -> synced id) for each alias (resolve the derived id back to its chrome id first).
  // apply:           ops = diffLive(current, target), ordered: folder creates parents-first, then url creates,
  //                  moves (index = rank among the target's siblings by Position), updates, removes children-first (removeTree for folders).
  //                  After each create: IdMap.put(syncedId, node.id) immediately, one small write per node.
  //                  Stops after maxWritesPerApply ops or on the quota error ("exceeds the MAX_WRITE_OPERATIONS_PER_HOUR
  //                  quota"): returns { kind: 'deferred', why: 'quota', remaining }. The next cycle recomputes the diff
  //                  from the tree, so the remainder needs no queue.
  throw new Error('not implemented');
}
