// The reading list as a register type. chrome.readingList never appears here (see chrome-reading-list.ts).
//
// The reading list is keyed by url, so an entry's ItemId is a hash of its url. Every device derives the same id
// for the same page: no id map, no adoption by content, and two devices adding one page make one entry.
import { isItemId, type ItemId, type Live, type RegisterType } from './model.ts';
import { isSyncableUrl } from './history.ts';
import { sha256 } from './store-format.ts';

/** `url` is a register like every field, but it never changes: the id is derived from it. */
export type ReadingItem = { readonly kind: 'entry'; readonly url: string; readonly title: string; readonly read: boolean };

const TITLE_MAX = 512;

export async function readingItemId(url: string): Promise<ItemId> {
  const id = `rl.${(await sha256(new TextEncoder().encode(url))).slice(0, 40)}`;
  if (!isItemId(id)) throw new Error(`bad reading list id ${id}`);
  return id;
}

/**
 * One entry per url. Honest devices never produce two (the id is the url's hash), but a peer file could, and
 * Chromium refuses a second entry for a url, which would interrupt every apply. The lowest id keeps the url.
 */
function normalize(live: Live<ReadingItem>): Live<ReadingItem> {
  const byUrl = new Map<string, ItemId>();
  for (const [id, item] of live) {
    const held = byUrl.get(item.url);
    if (held === undefined || id < held) byUrl.set(item.url, id);
  }
  return new Map([...live].filter(([id, item]) => byUrl.get(item.url) === id));
}

export const readingList: RegisterType<ReadingItem> = {
  model: 'register',
  name: 'reading-list',
  version: 1,

  parseRecord(raw) {
    const { url, title, read } = raw;
    if (raw.kind !== 'entry' || typeof url !== 'string' || !isSyncableUrl(url) || typeof title !== 'string' || typeof read !== 'boolean') return null;
    return { kind: 'entry', url, title: title.slice(0, TITLE_MAX), read };
  },

  // Ids are content-derived, so a profile's entries already carry their synced ids.
  adopt: ({ local }) => ({ live: local, aliases: new Map() }),
  normalize,
  references: () => [],
  emptyReadIsSuspect: false,

  label(item) {
    return item.title === '' ? item.url : item.title;
  },
};
