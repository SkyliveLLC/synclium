// Bookmarks as a DataType. The adapter parses Chromium's Bookmarks JSON into a flat Snapshot and writes back by
// editing the existing document, so fields we do not model (date_last_used, meta_info, ...) survive untouched.

import { defineDataType, type ItemId, type Snapshot } from '../datatype.ts';
import type { ProfileDir, WritableProfile } from '../profile.ts';

/**
 * `location` is one register, not two: a move changes parent and position together, and a position is
 * meaningless under a different parent. `pos` is a fractional-index string (P3: fractional positions within
 * folder), so inserting between neighbours never renumbers siblings.
 */
export type BookmarkFields = {
  readonly kind: 'url' | 'folder';
  readonly title: string;
  readonly url: string | null; // null for folders
  readonly location: { readonly parent: ItemId; readonly pos: string };
};

/** The three permanent roots. Not items; every top-level item's parent is one of these. */
export const ROOTS = {
  bar: '0bc5d13f-2cba-5d74-951f-3f233fe6c908' as ItemId,
  other: '82b081ec-3dd3-529c-8475-ab6c344590dd' as ItemId,
  mobile: '4cf2e351-0e85-532b-bb37-df045d8f8d0f' as ItemId,
} as const;

/**
 * Chromium Bookmarks file, parsed at the boundary. Only the fields we read are typed; the raw node is kept so
 * `write` can preserve the rest. `version` must be 1 (unchanged since 2010); anything else is SchemaUnsupported.
 */
type BookmarksDoc = {
  readonly version: 1;
  readonly roots: Record<'bookmark_bar' | 'other' | 'synced', RawNode>;
  readonly checksum?: string;
};
type RawNode = {
  readonly guid: string;
  readonly id: string; // local integer id as string; we assign max+1 for new nodes
  readonly type: 'url' | 'folder';
  readonly name: string;
  readonly url?: string;
  readonly date_added: string;
  readonly children?: readonly RawNode[];
  readonly [other: string]: unknown; // preserved verbatim
};

function parseBookmarksDoc(bytes: Uint8Array): BookmarksDoc {
  throw new Error('not implemented');
}

/** MD5 preorder of (id utf8, name utf16le, "url"+url | "folder"+children); reproduced exactly in P1. */
export function checksum(doc: BookmarksDoc): string {
  throw new Error('not implemented');
}

/**
 * Flatten to a Snapshot. Positions: keep `baseline`'s pos for nodes whose relative order within the parent is
 * unchanged (greedy increasing run), interpolate fractional strings for the rest. Without this every read would
 * look like a reorder of the whole folder.
 */
async function read(profile: ProfileDir, baseline: Snapshot<BookmarkFields> | null): Promise<Snapshot<BookmarkFields>> {
  throw new Error('not implemented');
}

/**
 * Edit the existing document to match `target`:
 *   - rename/retarget/move nodes by guid; append new nodes with fresh local ids and date_added = now (µs since 1601)
 *   - remove nodes absent from target (their subtrees are already tombstoned by the merge)
 *   - rewrite guids for aliased nodes (first join) so the browser's guid becomes the sync id
 *   - order children by pos, recompute checksum, `profile.replace('Bookmarks', ...)`
 * Chromium then writes Bookmarks.bak itself on next launch; we keep our own backup via replace().
 */
async function write(profile: WritableProfile, target: Snapshot<BookmarkFields>): Promise<void> {
  throw new Error('not implemented');
}

/**
 * P3 adoptGuids: top-down, match (mapped parent, kind, title, url) to a remote item not already in the local
 * tree, so a folder adoption carries its children. Unmatched items keep their local guid and become new items.
 */
function adopt(local: Snapshot<BookmarkFields>, remote: Snapshot<BookmarkFields>): ReadonlyMap<ItemId, ItemId> {
  throw new Error('not implemented');
}

/** P3 rescueOrphans: a live node whose parent is dead goes under the nearest live ancestor, else ROOTS.other. */
function repair(live: Snapshot<BookmarkFields>, tombstoned: (id: ItemId) => BookmarkFields | undefined): Snapshot<BookmarkFields> {
  throw new Error('not implemented');
}

export const bookmarks = defineDataType<BookmarkFields>({
  name: 'bookmarks',
  fieldKeys: ['kind', 'title', 'url', 'location'],
  read,
  write,
  adopt,
  repair,
});
