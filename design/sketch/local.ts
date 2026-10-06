// Device-private state: one IndexedDB database, "helium-sync", shared by the worker and the extension pages
// (same origin). IndexedDB rather than chrome.storage.local because it stores Maps and directory handles as
// structured clones, commits several records in one transaction, and indexes peer visits for search.
// Our own data, written only by this extension, so rows are trusted on read.
//
// Object stores, and their single writer (per separate-before-serializing-shared-state):
//   kv          'device' DeviceLocal (worker)  'intent' Intent (worker)
//               'folder:candidate' handle (app page)  'folder:current' handle (worker, promoteCandidate)
//   idmap       chrome id -> ItemId, unique index on ItemId (worker)
//   ownDays     DayKey -> { meta: OwnDay, events: Visit[] } (worker)
//   peerDays    StoreKey -> manifest hash applied (worker)
//   peerVisits  [device, day, url, t] -> RemoteVisit, indexes on t and on [url, t] (worker)
//   ingested    EventKey -> t, index on t (worker)
//
// chrome.storage.local holds what the popup renders: the last SyncReport and the companion status (worker
// writes, pages read via storage.onChanged, which never wakes the worker).
import type { DeviceId, ItemId } from './model.ts';
import type { Visit } from './history.ts';
import type { ChromeId } from './chrome-bookmarks.ts';
import type { HandleSlot } from './folder-store.ts';
import type { IntentStore } from './scheduler.ts';
import type { LocalState, LogLocal, LogSink } from './ports.ts';

export function indexedLocal(): LocalState {
  throw new Error('not implemented');
}

export function historyLocal(): LogLocal<Visit> {
  throw new Error('not implemented');
}

export function intents(): IntentStore {
  throw new Error('not implemented');
}

export type RemoteVisit = Visit & { readonly device: DeviceId; readonly deviceName: string };

/** The default history sink: peers' visits in `peerVisits`, plus the search the History page and omnibox use. */
export function historyIndex(): LogSink<Visit> & {
  /** Case-insensitive substring over title and url, newest first. A cursor scan over the `t` index. */
  search(query: string, limit: number): Promise<readonly RemoteVisit[]>;
} {
  throw new Error('not implemented');
}

export const handles = {
  get(_slot: HandleSlot): Promise<FileSystemDirectoryHandle | undefined> {
    throw new Error('not implemented');
  },
  put(_slot: HandleSlot, _handle: FileSystemDirectoryHandle): Promise<void> {
    throw new Error('not implemented');
  },
};

/** The chrome id <-> ItemId map. Used only by chrome-bookmarks.ts. */
export const idMap = {
  all(): Promise<ReadonlyMap<ChromeId, ItemId>> {
    throw new Error('not implemented');
  },
  /** Upsert. Rebinding an ItemId to a new chrome id drops the old row (unique index). */
  set(_entries: Iterable<readonly [ChromeId, ItemId]>): Promise<void> {
    throw new Error('not implemented');
  },
  remove(_ids: Iterable<ChromeId>): Promise<void> {
    throw new Error('not implemented');
  },
};
