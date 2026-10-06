// Registry entry: bookmarks. Both halves live here; the extension bundle calls `browser`, the host calls the rest.
// This file is the whole cost of a data type: records, parse, chrome calls, observe/normalize/realize.

import type { Brand, Live, LocalId, MergeType, ObserveContext, SyncId } from '../engine/model.ts';

/** Fractional-index key (base62 string). Order inside a folder = (pos, SyncId). Keys between any two always exist. */
export type Position = Brand<string, 'Position'>;
/** Any string Chromium accepted as a bookmark URL. Not normalized: we sync exactly what the user saved. */
export type Url = Brand<string, 'Url'>;
/** Parent and order move together as one register, so a concurrent move never splits parent from position. */
export type Location = { readonly parent: SyncId; readonly pos: Position };

export type Bookmark =
  | { readonly kind: 'folder'; readonly title: string; readonly location: Location }
  | { readonly kind: 'url'; readonly title: string; readonly url: Url; readonly location: Location };

/**
 * Permanent folders. Not records: never created, renamed or deleted. Chromium's well-known root guids, so a
 * future file-based adapter (which sees real guids) agrees with us. The mobile root is absent from
 * chrome.bookmarks.getTree when empty (observed: root has 2 children) so v1 does not sync it.
 */
export const ROOTS = {
  'bookmarks-bar': '0bc5d13f-2cba-5d74-951f-3f233fe6c908' as SyncId,
  other: '82b081ec-3dd3-529c-8475-ab6c344590dd' as SyncId,
} as const;
type RootKind = keyof typeof ROOTS;

// ---------- Extension half (the only code here that touches chrome.*) ----------

/** One node as the extension reports it. Bridge-only; parsed by `parseLocalTree` on the host. */
type LocalNode = {
  id: string;
  parent: string | null;
  index: number;
  title: string;
  url: string | null;
  root: RootKind | null;
};

const browser = (api: typeof chrome) => ({
  ops: {
    /** Flattened chrome.bookmarks.getTree(); skips the invisible root and managed folders. */
    async read(): Promise<LocalNode[]> {
      throw new Error('not implemented');
    },
    async create(a: { parent: string; index: number; title: string; url: string | null }): Promise<string> {
      throw new Error('not implemented'); // api.bookmarks.create(...) -> new id. Cannot set dateAdded or guid.
    },
    async update(a: { id: string; title: string; url: string | null }): Promise<null> {
      throw new Error('not implemented');
    },
    async move(a: { id: string; parent: string; index: number }): Promise<null> {
      throw new Error('not implemented');
    },
    /** removeTree: callers only remove the topmost deleted node of a subtree. */
    async remove(a: { id: string }): Promise<null> {
      throw new Error('not implemented');
    },
  },
  changes: [
    api.bookmarks.onCreated,
    api.bookmarks.onRemoved,
    api.bookmarks.onChanged,
    api.bookmarks.onMoved,
    api.bookmarks.onChildrenReordered,
    api.bookmarks.onImportEnded,
  ],
});
type BookmarkOps = ReturnType<typeof browser>['ops'];

// ---------- Host half ----------

export const bookmarks: MergeType<Bookmark, BookmarkOps> = {
  name: 'bookmarks',
  mode: 'merge',
  permissions: ['bookmarks'],
  browser,

  parse(raw) {
    // kind 'folder' -> {title, location}; kind 'url' -> {title, url, location}; anything else -> undefined.
    throw new Error('not implemented');
  },

  async observe(remote, ctx) {
    // nodes  = parseLocalTree(await remote.read(undefined))
    // ids    = adopt(nodes, ctx)            unmapped nodes -> SyncId of a `known` item, else ctx.mint()
    // live   = withPositions(nodes, ids, ctx.known)   indices -> stable Position keys
    throw new Error('not implemented');
  },

  normalize(live, dead) {
    // Pure and stamp-free, so every device derives the same tree from the same merge (nothing to sync back).
    // 1. Break move cycles (A moved into B and B into A concurrently): the cycle member with the smallest
    //    SyncId is re-homed under ROOTS.other.
    // 2. Re-home orphans under the nearest live ancestor (walking `dead` locations), else ROOTS.other.
    throw new Error('not implemented');
  },

  async realize(remote, target, observed) {
    // Order matters and is fixed:
    //  1. create missing items top-down (parent first), recording SyncId -> new LocalId as we go
    //  2. move items whose Location changed, per folder in target order (index = rank by (pos, SyncId))
    //  3. update title/url where changed
    //  4. remove items gone from target; only the topmost of each removed subtree (removeTree)
    // A failed op (user deleted the parent mid-run) is recorded and skipped; the next observe sees the truth.
    throw new Error('not implemented');
  },
};

/** Bridge boundary: unknown -> LocalNode[] with LocalId brands. Throws on a malformed tree (extension bug). */
function parseLocalTree(raw: unknown): readonly (Omit<LocalNode, 'id' | 'parent'> & { id: LocalId; parent: LocalId | null })[] {
  throw new Error('not implemented');
}

/**
 * Top-down content match (parent already mapped, kind, title, url), first unused candidate wins.
 * REQUIRED at first join or every bookmark duplicates (P3). Also repairs ids lost to a crash mid-realize.
 */
function adopt(nodes: ReturnType<typeof parseLocalTree>, ctx: ObserveContext<Bookmark>): Map<SyncId, LocalId> {
  throw new Error('not implemented');
}

/** Keep the previous Position for the longest run of children still in order; generate keys between for the rest. */
function withPositions(nodes: ReturnType<typeof parseLocalTree>, ids: Map<SyncId, LocalId>, known: Live<Bookmark>): Live<Bookmark> {
  throw new Error('not implemented');
}
