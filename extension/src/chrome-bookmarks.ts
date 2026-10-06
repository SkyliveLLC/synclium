// Bookmarks through chrome.bookmarks. Owns the ItemId <-> chrome id map (round 1: "id mapping belongs to the
// adapter, never the engine"). The API exposes no guid and rejects a caller-chosen id (P2), so the map is the
// only link between a synced item and a node in this profile.
import { isItemId, type Brand, type ItemId, type Live } from './model.ts';
import { ROOTS, childrenOf, isRoot, placeChildren, type Bookmark } from './bookmarks.ts';
import type { ApplyResult, RegisterChannel } from './ports.ts';
import { idMap } from './local.ts';

/** chrome.bookmarks node id. Per profile; stable across restarts; reassigned only if Chromium repairs a corrupt file. */
export type ChromeId = Brand<string, 'ChromeId'>;
export const isChromeId = (s: string): s is ChromeId => /^\d+$/.test(s);

/**
 * Roots map by `folderType` (Chrome 134+, observed in Helium), not by the ids '1'/'2'/'3'. Roots are never in
 * the id map, never created, renamed, or removed. Managed folders are skipped. Exhaustive over chrome's
 * FolderType, so a new folder type fails to compile until it is mapped or skipped.
 */
type SyncedFolderType = Exclude<NonNullable<chrome.bookmarks.BookmarkTreeNode['folderType']>, 'managed'>;
export const ROOT_BY_FOLDER_TYPE = { 'bookmarks-bar': ROOTS.bar, other: ROOTS.other, mobile: ROOTS.mobile } as const satisfies {
  readonly [K in SyncedFolderType]: ItemId;
};

const isSyncedFolderType = (type: string | undefined): type is SyncedFolderType => type !== undefined && type in ROOT_BY_FOLDER_TYPE;

/**
 * One API call each. `create` and `move` carry the index the call takes: the browser's index after every
 * earlier op ran. A `move` within one folder always goes to a lower index, so Chromium's adjustment for a move
 * to a higher index (the index counts the moved node itself) never applies.
 */
export type BookmarkOp =
  | { readonly op: 'create'; readonly id: ItemId; readonly record: Bookmark; readonly index: number }
  | { readonly op: 'move'; readonly id: ItemId; readonly parent: ItemId; readonly index: number }
  | { readonly op: 'update'; readonly id: ItemId; readonly title: string; readonly url: string | null }
  /** `tree`: a folder that still has children when its turn comes (removeTree). Its descendants get no op. */
  | { readonly op: 'remove'; readonly id: ItemId; readonly tree: boolean };

/**
 * Pure. The ordered API calls that turn `current` into `target`. `current` lists what the browser shows, in
 * its order; `target` is normalized, so every item reaches a root.
 *   1. Walk target folders top-down from the roots. For each child in target order: create it if it is new, or
 *      move it to the next slot if something that stays here holds that slot. Nodes leaving the folder are
 *      stepped over. Parents are created before their children, and items leave folders about to be removed.
 *   2. Update titles and urls.
 *   3. Remove what the target lacks, topmost first; a folder takes its remaining subtree with it.
 */
export function planApply(current: Live<Bookmark>, target: Live<Bookmark>): readonly BookmarkOp[] {
  const ops: BookmarkOp[] = [];
  const lists = new Map<ItemId, ItemId[]>([...childrenOf(current)].map(([parent, ids]) => [parent, [...ids]]));
  const parentOf = new Map<ItemId, ItemId>([...current].map(([id, b]) => [id, b.location.parent]));
  const listOf = (parent: ItemId): ItemId[] => {
    let list = lists.get(parent);
    if (list === undefined) lists.set(parent, (list = []));
    return list;
  };
  const wanted = childrenOf(target);

  const place = (parent: ItemId) => {
    const list = listOf(parent);
    let at = 0;
    for (const id of wanted.get(parent) ?? []) {
      // Nodes that are leaving this folder (removed, or moving elsewhere) are stepped over, not displaced.
      for (let here = list[at]; here !== undefined && here !== id && target.get(here)?.location.parent !== parent; here = list[at]) at++;
      if (list[at] !== id) {
        const record = target.get(id);
        const from = parentOf.get(id);
        if (record === undefined) continue;
        if (from === undefined) ops.push({ op: 'create', id, record, index: at });
        else {
          const old = listOf(from);
          old.splice(old.indexOf(id), 1);
          ops.push({ op: 'move', id, parent, index: at });
        }
        list.splice(at, 0, id);
        parentOf.set(id, parent);
      }
      at++;
    }
    for (const id of wanted.get(parent) ?? []) if (target.get(id)?.kind === 'folder') place(id);
  };
  for (const root of Object.values(ROOTS)) place(root);

  for (const [id, after] of target) {
    const before = current.get(id);
    if (before === undefined) continue;
    const url = after.kind === 'url' ? after.url : null;
    if (before.title !== after.title || (before.kind === 'url' ? before.url : null) !== url) ops.push({ op: 'update', id, title: after.title, url });
  }

  for (const id of current.keys()) {
    const parent = parentOf.get(id);
    if (target.has(id) || (parent !== undefined && !target.has(parent) && current.has(parent))) continue;
    ops.push({ op: 'remove', id, tree: (lists.get(id)?.length ?? 0) > 0 });
  }
  return ops;
}

function mintItemId(): ItemId {
  const id = crypto.randomUUID();
  if (!isItemId(id)) throw new Error(`randomUUID gave ${id}`);
  return id;
}

function chromeIdOf(node: chrome.bookmarks.BookmarkTreeNode): ChromeId {
  if (!isChromeId(node.id)) throw new Error(`chrome.bookmarks gave a non-numeric id ${node.id}`);
  return node.id;
}

/** The synced roots in this profile, by ItemId. The first node of each folder type wins. */
function rootsOf(tree: readonly chrome.bookmarks.BookmarkTreeNode[]): ReadonlyMap<ItemId, chrome.bookmarks.BookmarkTreeNode> {
  const roots = new Map<ItemId, chrome.bookmarks.BookmarkTreeNode>();
  for (const top of tree)
    for (const node of top.children ?? []) {
      if (node.unmodifiable !== undefined || !isSyncedFolderType(node.folderType)) continue;
      const root = ROOT_BY_FOLDER_TYPE[node.folderType];
      if (!roots.has(root)) roots.set(root, node);
    }
  return roots;
}

export function chromeBookmarks(): RegisterChannel<Bookmark> {
  return {
    async read(previous) {
      const [tree, mapped] = await Promise.all([chrome.bookmarks.getTree(), idMap.all()]);
      const minted: [ChromeId, ItemId][] = [];
      const seen = new Set<ChromeId>();
      const children = new Map<ItemId, ItemId[]>();
      const nodes = new Map<ItemId, chrome.bookmarks.BookmarkTreeNode>();
      const visit = (parent: ItemId, node: chrome.bookmarks.BookmarkTreeNode) => {
        const list: ItemId[] = [];
        for (const child of node.children ?? []) {
          if (child.unmodifiable !== undefined) continue;
          const chromeId = chromeIdOf(child);
          seen.add(chromeId);
          let item = mapped.get(chromeId);
          if (item === undefined) minted.push([chromeId, (item = mintItemId())]);
          list.push(item);
          nodes.set(item, child);
          visit(item, child);
        }
        children.set(parent, list);
      };
      for (const [root, node] of rootsOf(tree)) visit(root, node);

      // Saved before read returns, so a crash never mints a second id for one node. Rows for nodes that left
      // the tree go in the same call, which keeps the map the size of the tree.
      const gone = [...mapped.keys()].filter((chromeId) => !seen.has(chromeId));
      if (minted.length > 0) await idMap.set(minted);
      if (gone.length > 0) await idMap.remove(gone);

      const placed = placeChildren(children, previous);
      const live = new Map<ItemId, Bookmark>();
      for (const [item, node] of nodes) {
        const location = placed.get(item);
        if (location === undefined) throw new Error(`unplaced bookmark ${node.id}`);
        live.set(item, node.url === undefined ? { kind: 'folder', title: node.title, location } : { kind: 'url', title: node.title, url: node.url, location });
      }
      return live;
    },

    /** Rewrite map rows: the node read as `from` is synced item `to`. The minted `from` id was never published. */
    async bind(aliases) {
      const byItem = new Map([...(await idMap.all())].map(([chromeId, item]) => [item, chromeId]));
      const rows: [ChromeId, ItemId][] = [];
      for (const [from, to] of aliases) {
        const chromeId = byItem.get(from);
        if (chromeId !== undefined) rows.push([chromeId, to]);
      }
      await idMap.set(rows);
    },

    /*
     * The plan, one call at a time, with the budget checked before each. A created node's map row is saved right
     * after its create. Budget gone -> 'stopped'. Any throw -> 'interrupted' (usually the user edited the same
     * node mid-apply). Either way the next cycle re-plans from what the tree shows, so nothing is queued. Our
     * own calls fire bookmark events, which request one more cycle; it reads observed == applied and stops.
     */
    async apply({ current, target }, budget): Promise<ApplyResult> {
      const [tree, mapped] = await Promise.all([chrome.bookmarks.getTree(), idMap.all()]);
      const chromeOf = new Map<ItemId, ChromeId>([...mapped].map(([chromeId, item]) => [item, chromeId]));
      for (const [root, node] of rootsOf(tree)) chromeOf.set(root, chromeIdOf(node));
      const resolve = (id: ItemId): ChromeId => {
        const chromeId = chromeOf.get(id);
        if (chromeId === undefined) throw new Error(`no bookmark node for ${isRoot(id) ? 'root ' : ''}${id}`);
        return chromeId;
      };

      try {
        for (const op of planApply(current, target)) {
          if (budget.expired()) return { kind: 'stopped' };
          switch (op.op) {
            case 'create': {
              const { record } = op;
              const node = await chrome.bookmarks.create({
                parentId: resolve(record.location.parent),
                index: op.index,
                title: record.title,
                ...(record.kind === 'url' ? { url: record.url } : {}),
              });
              const chromeId = chromeIdOf(node);
              await idMap.set([[chromeId, op.id]]);
              chromeOf.set(op.id, chromeId);
              break;
            }
            case 'move':
              await chrome.bookmarks.move(resolve(op.id), { parentId: resolve(op.parent), index: op.index });
              break;
            case 'update':
              await chrome.bookmarks.update(resolve(op.id), op.url === null ? { title: op.title } : { title: op.title, url: op.url });
              break;
            case 'remove':
              await (op.tree ? chrome.bookmarks.removeTree(resolve(op.id)) : chrome.bookmarks.remove(resolve(op.id)));
              break;
            default: {
              const unreachable: never = op;
              return unreachable;
            }
          }
        }
      } catch (error) {
        return { kind: 'interrupted', detail: error instanceof Error ? error.message : String(error) };
      }
      return { kind: 'applied' };
    },
  };
}
