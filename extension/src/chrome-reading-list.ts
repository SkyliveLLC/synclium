// The reading list through chrome.readingList. The API is keyed by url, which is also where ItemIds come
// from (reading-list.ts), so this channel keeps no id map.
import { diffLive } from './crdt.ts';
import type { ItemId } from './model.ts';
import { isSyncableUrl } from './history.ts';
import { readingItemId, type ReadingItem } from './reading-list.ts';
import type { ApplyResult, RegisterChannel } from './ports.ts';

/** The calls this channel makes. chrome.readingList in the worker; a fake in tests. */
export interface ReadingListApi {
  query(info: chrome.readingList.QueryInfo): Promise<chrome.readingList.ReadingListEntry[]>;
  addEntry(entry: chrome.readingList.AddEntryOptions): Promise<void>;
  updateEntry(info: chrome.readingList.UpdateEntryOptions): Promise<void>;
  removeEntry(info: chrome.readingList.RemoveOptions): Promise<void>;
}

export function readingListChannel(api: ReadingListApi): RegisterChannel<ReadingItem> {
  return {
    /** http(s) entries only, the same rule peer files are held to. */
    async read() {
      const live = new Map<ItemId, ReadingItem>();
      for (const entry of await api.query({}))
        if (isSyncableUrl(entry.url)) live.set(await readingItemId(entry.url), { kind: 'entry', url: entry.url, title: entry.title, read: entry.hasBeenRead });
      return live;
    },

    async bind() {},

    /*
     * One call per change, budget checked before each. Any throw is 'interrupted' (usually the user changed
     * the same entry mid-apply); the next cycle re-reads the list and re-plans, so nothing is queued.
     */
    async apply({ current, target }, budget): Promise<ApplyResult> {
      try {
        for (const change of diffLive(current, target)) {
          if (budget.expired()) return { kind: 'stopped' };
          switch (change.op) {
            case 'add':
              await api.addEntry({ url: change.after.url, title: change.after.title, hasBeenRead: change.after.read });
              break;
            case 'update':
              await api.updateEntry({ url: change.after.url, title: change.after.title, hasBeenRead: change.after.read });
              break;
            case 'remove':
              await api.removeEntry({ url: change.before.url });
              break;
            default: {
              const unreachable: never = change;
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
