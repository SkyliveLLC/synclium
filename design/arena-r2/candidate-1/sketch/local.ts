// Device-private state: one IndexedDB database, "helium-sync", shared by the service worker and the
// extension pages (same origin). IndexedDB rather than chrome.storage.local because it stores Maps and
// FileSystemDirectoryHandles as structured clones, commits several records in one transaction, and indexes
// peer visits for search. chrome.storage.local holds one derived thing: the last SyncReport, which the popup
// reads without waking the worker (background.ts).
//
// Object stores (schema version 1):
//   kv          'device' -> DeviceLocal, 'folder' -> FileSystemDirectoryHandle
//   idmap       chrome bookmark id -> ItemId, unique index on ItemId
//   ownDays     DayKey -> { meta: OwnDayMeta, visits: Visit[] }
//   peerShards  StoreKey -> PeerShardMeta
//   peerVisits  [device, day, url, t] -> RemoteVisit, indexes on t and on [url, t]
import type { ItemId } from './model.ts';
import type { ChromeId } from './chrome-bookmarks.ts';
import type { DeviceLocal, HistoryDb, LocalState } from './ports.ts';

type Kv = { readonly device: DeviceLocal; readonly folder: FileSystemDirectoryHandle };

/** Typed access to the kv store. Our own data, written only by this extension, so it is trusted on read. */
export const kv = {
  get<K extends keyof Kv>(_key: K): Promise<Kv[K] | undefined> {
    throw new Error('not implemented');
  },
  put<K extends keyof Kv>(_key: K, _value: Kv[K]): Promise<void> {
    throw new Error('not implemented');
  },
};

/**
 * `lock` is navigator.locks.request('helium-sync', fn). The worker's cycle and the app page's setup both
 * take it. The browser releases it when its holder's context dies, so a terminated worker never strands it
 * (round 1 needed pid files and stale-lock takeover for this).
 */
export function indexedLocal(): LocalState {
  throw new Error('not implemented');
}

export function indexedHistoryDb(): HistoryDb {
  throw new Error('not implemented');
}

/** The chrome id <-> ItemId map. Owned by chrome-bookmarks.ts; persisted here. */
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
