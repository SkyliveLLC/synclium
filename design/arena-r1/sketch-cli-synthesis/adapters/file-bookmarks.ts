// Chromium's Bookmarks JSON, in and out. The only module that knows the file's shape.
import type { ReadChannel, WriteChannel } from '../ports.ts';
import type { Bookmark } from '../types/bookmarks.ts';
import type { WritableProfile } from './file-profile.ts';

export type BookmarkFiles = {
  /** `<userDataDir>/<profile>/Bookmarks` */
  readonly bookmarks: string;
  /** Adapter-private alias table, `<stateDir>/bookmark-aliases.json`. */
  readonly aliases: string;
};

/**
 * `read(previous)` parses the file, flattens roots (bookmark_bar, other, synced map to ROOTS bar, other, mobile),
 * resolves each guid through the alias table, and derives positions with `placeChildren(children, previous)`.
 *
 * `bind(aliases)` merges into the alias table on disk. A local guid stays aliased until the next offline write
 * rewrites it. P1 showed Chromium loads whatever guid the file holds.
 *
 * `apply({ target })` exists on the writable overload only. It edits the existing document and never regenerates it.
 *  - keep each surviving node's local `id`, `date_added`, `meta_info`, and unknown fields
 *  - rewrite aliased guids to their synced ItemId
 *  - new nodes get guid = ItemId, a fresh local id (max + 1), date_added = now in Chromium µs since 1601
 *  - order children by position, recompute the MD5 checksum (reproduced exactly in P1)
 *  - w.replace('Bookmarks', bytes). On `replaced`, clear the rewritten aliases and return applied.
 */
export function bookmarksChannel(files: BookmarkFiles): ReadChannel<Bookmark>;
export function bookmarksChannel(files: BookmarkFiles, writable: WritableProfile): WriteChannel<Bookmark>;
export function bookmarksChannel(_files: BookmarkFiles, _writable?: WritableProfile): ReadChannel<Bookmark> | WriteChannel<Bookmark> {
  throw new Error('not implemented');
}

/** Boundary parse. Only `version: 1` documents. Raw nodes keep unknown fields so a rewrite preserves them. */
type RawNode = {
  readonly guid: string;
  readonly id: string;
  readonly type: 'url' | 'folder';
  readonly name: string;
  readonly url?: string;
  readonly date_added: string;
  readonly children?: readonly RawNode[];
  readonly rest: { readonly [field: string]: unknown };
};
type BookmarksDoc = {
  readonly version: 1;
  readonly roots: { readonly bookmark_bar: RawNode; readonly other: RawNode; readonly synced: RawNode };
};

function parseBookmarksDoc(_bytes: Uint8Array): BookmarksDoc {
  throw new Error('not implemented');
}

/** MD5 over preorder (id utf8, name utf16le, "url" + url or "folder" + children). */
function checksum(_doc: BookmarksDoc): string {
  throw new Error('not implemented');
}
