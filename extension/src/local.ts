// Device-private state: one IndexedDB database, "helium-sync", shared by the worker and the extension pages
// (same origin). IndexedDB rather than chrome.storage.local because it stores Maps and directory handles as
// structured clones, commits several records in one transaction, and indexes peer visits for search.
// Our own data, written only by this module, so rows are trusted on read.
//
// Object stores, and their single writer (per DESIGN.md "Local state has one writer per record"):
//   kv          'device' DeviceLocal (worker)  'intent' Intent (worker)
//               'folder:candidate' handle (app page)  'folder:current' handle (worker, on Start)
//   idmap       { chrome, item } keyed by chrome id, unique index on item (worker)
//   ownDays     DayKey -> OwnDay (worker)
//   ownEvents   DayKey -> Visit[], apart from ownDays so listing days never loads megabytes (worker)
//   peerDays    { key: StoreKey, hash } keyed by key: the manifest hash applied (worker)
//   peerVisits  [device, day, url, t] -> PeerVisitRow, index on t (worker)
//   ingested    { key: EventKey, t } keyed by key, index on t (worker)
//
// chrome.storage.local holds only what the pages render (see background.ts `publishStatus`).
import { dayOf, isDayKey, isDeviceId, type DayKey, type DeviceId, type EventKey, type ItemId } from './model.ts';
import { history, type Visit } from './history.ts';
import { freshDeviceLocal, noAsks, type DeviceLocal, type LocalState, type LogLocal, type LogSink, type OwnDay } from './ports.ts';
import { joinCursor } from './log-cycle.ts';
import { parseKey, type StoreKey } from './store-format.ts';
import { ASK_OF, type Intent, type IntentStore, type Trigger } from './scheduler.ts';
import type { ChromeId } from './chrome-bookmarks.ts';

/** `candidate` is what setup picked; `current` is what sync uses. Start promotes one to the other. */
export type HandleSlot = 'current' | 'candidate';

export type RemoteVisit = Visit & { readonly device: DeviceId; readonly deviceName: string };

type Kv = {
  readonly device: DeviceLocal;
  readonly intent: Intent;
  readonly 'folder:candidate': FileSystemDirectoryHandle;
  readonly 'folder:current': FileSystemDirectoryHandle;
};
type IdRow = { readonly chrome: ChromeId; readonly item: ItemId };
type PeerDayRow = { readonly key: StoreKey; readonly hash: string };
type PeerVisitRow = RemoteVisit & { readonly day: DayKey };
type IngestedRow = { readonly key: EventKey; readonly t: number };

type StoreName = 'kv' | 'idmap' | 'ownDays' | 'ownEvents' | 'peerDays' | 'peerVisits' | 'ingested';
const SYNC_STATE: readonly StoreName[] = ['kv', 'ownDays', 'ownEvents', 'peerDays', 'peerVisits', 'ingested'];

const DB_NAME = 'helium-sync';
const DB_VERSION = 1;

let opening: Promise<IDBDatabase> | null = null;

function database(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('kv');
      db.createObjectStore('idmap', { keyPath: 'chrome' }).createIndex('item', 'item', { unique: true });
      db.createObjectStore('ownDays');
      db.createObjectStore('ownEvents');
      db.createObjectStore('peerDays', { keyPath: 'key' });
      db.createObjectStore('peerVisits', { keyPath: ['device', 'day', 'url', 't'] }).createIndex('t', 't');
      db.createObjectStore('ingested', { keyPath: 'key' }).createIndex('t', 't');
    };
    req.onsuccess = () => {
      const db = req.result;
      // A newer version opened elsewhere (an extension update with a live page): let it upgrade, reopen next call.
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      opening = null;
      reject(req.error);
    };
  });
  return opening;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * One transaction. `body` may await requests on `tx` (each continuation runs while the transaction is active),
 * but nothing else. Resolves after the commit, so a caller that sequences on it gets crash ordering.
 */
async function transact<T>(names: readonly StoreName[], mode: IDBTransactionMode, body: (tx: IDBTransaction) => Promise<T>): Promise<T> {
  const tx = (await database()).transaction(names, mode);
  const committed = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
  committed.catch(() => {}); // observed below; this only keeps an early body throw from leaving it unhandled
  try {
    const result = await body(tx);
    await committed;
    return result;
  } catch (error) {
    try {
      tx.abort(); // never commit half of a body that threw
    } catch {
      // InvalidStateError: a failed request already aborted it
    }
    throw error;
  }
}

/** Visits every cursor position until `visit` returns false. */
function walk(req: IDBRequest<IDBCursorWithValue | null>, visit: (cursor: IDBCursorWithValue) => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor !== null && visit(cursor)) cursor.continue();
      else resolve();
    };
    req.onerror = () => reject(req.error);
  });
}

const kv = {
  get: <K extends keyof Kv>(tx: IDBTransaction, key: K): Promise<Kv[K] | undefined> => done(tx.objectStore('kv').get(key)),
  put: <K extends keyof Kv>(tx: IDBTransaction, key: K, value: Kv[K]): Promise<IDBValidKey> => done(tx.objectStore('kv').put(value, key)),
};

function mintDeviceId(): DeviceId {
  const id = crypto.randomUUID();
  if (!isDeviceId(id)) throw new Error(`randomUUID gave ${id}`);
  return id;
}

export function indexedLocal(): LocalState {
  return {
    load: () => transact(['kv'], 'readonly', async (tx) => (await kv.get(tx, 'device')) ?? null),
    save: (next) =>
      transact(['kv'], 'readwrite', async (tx) => {
        await kv.put(tx, 'device', next);
      }),
    reset: (setup) =>
      transact(['kv'], 'readwrite', async (tx) => {
        const fresh = freshDeviceLocal(mintDeviceId(), setup, joinCursor(Date.now(), history.retentionDays));
        await kv.put(tx, 'device', fresh);
        return fresh;
      }),
    // Keeps the id map (a rejoin's own earlier deletes hold), the intent counters, and the folder handles.
    clear: () =>
      transact(SYNC_STATE, 'readwrite', async (tx) => {
        await done(tx.objectStore('kv').delete('device'));
        for (const name of SYNC_STATE) if (name !== 'kv') await done(tx.objectStore(name).clear());
      }),
  };
}

export function historyLocal(): LogLocal<Visit> {
  return {
    ownDays: () =>
      transact(['ownDays'], 'readonly', async (tx) => {
        const days = new Map<DayKey, OwnDay>();
        await walk(tx.objectStore('ownDays').openCursor(), (cursor) => {
          const day = String(cursor.key);
          if (isDayKey(day)) days.set(day, cursor.value);
          return true;
        });
        return days;
      }),
    ownEvents: (day) =>
      transact(['ownEvents'], 'readonly', async (tx) => {
        const events: readonly Visit[] | undefined = await done(tx.objectStore('ownEvents').get(day));
        return events ?? [];
      }),
    saveOwnDay: (day, events, meta) =>
      transact(['ownDays', 'ownEvents'], 'readwrite', async (tx) => {
        await done(tx.objectStore('ownEvents').put(events, day));
        await done(tx.objectStore('ownDays').put(meta, day));
      }),
    deleteOwnDay: (day) =>
      transact(['ownDays', 'ownEvents'], 'readwrite', async (tx) => {
        await done(tx.objectStore('ownDays').delete(day));
        await done(tx.objectStore('ownEvents').delete(day));
      }),
    peerDays: () =>
      transact(['peerDays'], 'readonly', async (tx) => {
        const rows: readonly PeerDayRow[] = await done(tx.objectStore('peerDays').getAll());
        return new Map(rows.map((row) => [row.key, row.hash]));
      }),
    setPeerDay: (key, hash) =>
      transact(['peerDays'], 'readwrite', async (tx) => {
        const store = tx.objectStore('peerDays');
        if (hash === null) await done(store.delete(key));
        else await done(store.put({ key, hash } satisfies PeerDayRow));
      }),
    ingested: (keys) =>
      transact(['ingested'], 'readonly', async (tx) => {
        const store = tx.objectStore('ingested');
        const hits = await Promise.all(keys.map((key) => done(store.getKey(key))));
        return new Set(keys.filter((_, i) => hits[i] !== undefined));
      }),
    markIngested: (events) =>
      transact(['ingested'], 'readwrite', async (tx) => {
        const store = tx.objectStore('ingested');
        await Promise.all(events.map(({ key, t }) => done(store.put({ key, t } satisfies IngestedRow))));
      }),
    expire: (before) =>
      transact(['ingested', 'peerDays'], 'readwrite', async (tx) => {
        await walk(tx.objectStore('ingested').index('t').openCursor(IDBKeyRange.upperBound(before, true)), (cursor) => {
          cursor.delete();
          return true;
        });
        const oldest = dayOf(before);
        await walk(tx.objectStore('peerDays').openCursor(), (cursor) => {
          const row: PeerDayRow = cursor.value;
          const parsed = parseKey(row.key);
          if (parsed?.rel.kind === 'shard' && parsed.rel.day < oldest) cursor.delete();
          return true;
        });
      }),
  };
}

export function intents(): IntentStore {
  const empty: Intent = { requested: 0, completed: 0, failures: 0, asks: noAsks };
  const askOf: Partial<Record<Trigger, keyof Intent['asks']>> = ASK_OF;
  const update = (change: (intent: Intent) => Intent) =>
    transact(['kv'], 'readwrite', async (tx) => {
      const next = change((await kv.get(tx, 'intent')) ?? empty);
      await kv.put(tx, 'intent', next);
      return next;
    });
  return {
    request: async (trigger) => {
      const ask = askOf[trigger];
      await update((i) => ({ ...i, requested: i.requested + 1, asks: ask === undefined ? i.asks : { ...i.asks, [ask]: i.asks[ask] + 1 } }));
    },
    read: () => transact(['kv'], 'readonly', async (tx) => (await kv.get(tx, 'intent')) ?? empty),
    complete: async (upTo) => {
      await update((i) => ({ ...i, completed: Math.max(i.completed, upTo), failures: 0 }));
    },
    fail: async () => (await update((i) => ({ ...i, failures: i.failures + 1 }))).failures,
  };
}

/** Case-insensitive: every whitespace-separated term must appear in the title or the url. */
function matchesQuery(query: string): (visit: Visit) => boolean {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term !== '');
  return (visit) => {
    const haystack = `${visit.title}\n${visit.url}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  };
}

/** The default history sink: peers' visits in `peerVisits`, plus the search the History page and omnibox use. */
export function historyIndex(): LogSink<Visit> & {
  /** Newest first. A cursor scan over the `t` index, stopped at `limit` matches. */
  search(query: string, limit: number): Promise<readonly RemoteVisit[]>;
} {
  // Arrays sort after every string, so [device, day, []] bounds every key under (device, day).
  const dayRange = (device: DeviceId, day: DayKey) => IDBKeyRange.bound([device, day], [device, day, []]);
  return {
    put: (from, day, events) =>
      transact(['peerVisits'], 'readwrite', async (tx) => {
        const store = tx.objectStore('peerVisits');
        await done(store.delete(dayRange(from.device, day)));
        await Promise.all(
          events.map((v) => done(store.put({ url: v.url, title: v.title, t: v.t, device: from.device, deviceName: from.name, day } satisfies PeerVisitRow))),
        );
      }),
    drop: (device, day) =>
      transact(['peerVisits'], 'readwrite', async (tx) => {
        await done(tx.objectStore('peerVisits').delete(dayRange(device, day)));
      }),
    search: (query, limit) =>
      transact(['peerVisits'], 'readonly', async (tx) => {
        const matches = matchesQuery(query);
        const found: RemoteVisit[] = [];
        await walk(tx.objectStore('peerVisits').index('t').openCursor(null, 'prev'), (cursor) => {
          const row: PeerVisitRow = cursor.value;
          if (matches(row)) found.push({ url: row.url, title: row.title, t: row.t, device: row.device, deviceName: row.deviceName });
          return found.length < limit;
        });
        return found;
      }),
  };
}

export const handles = {
  get: (slot: HandleSlot): Promise<FileSystemDirectoryHandle | undefined> => transact(['kv'], 'readonly', (tx) => kv.get(tx, `folder:${slot}`)),
  /** App page only: the candidate slot is the one record a page writes. */
  putCandidate: (handle: FileSystemDirectoryHandle): Promise<void> =>
    transact(['kv'], 'readwrite', async (tx) => {
      await kv.put(tx, 'folder:candidate', handle);
    }),
  /** Worker, under the cycle lock, on Start. A missing candidate leaves `current` as it was. */
  promote: (): Promise<void> =>
    transact(['kv'], 'readwrite', async (tx) => {
      const candidate = await kv.get(tx, 'folder:candidate');
      if (candidate !== undefined) await kv.put(tx, 'folder:current', candidate);
    }),
};

/** The chrome id <-> ItemId map. Used only by chrome-bookmarks.ts. */
export const idMap = {
  all: (): Promise<ReadonlyMap<ChromeId, ItemId>> =>
    transact(['idmap'], 'readonly', async (tx) => {
      const rows: readonly IdRow[] = await done(tx.objectStore('idmap').getAll());
      return new Map(rows.map((row) => [row.chrome, row.item]));
    }),
  /** Upsert. Rebinding an ItemId to a new chrome id drops the old row, which the unique index would reject. */
  set: (entries: Iterable<readonly [ChromeId, ItemId]>): Promise<void> =>
    transact(['idmap'], 'readwrite', async (tx) => {
      const store = tx.objectStore('idmap');
      for (const [chrome, item] of entries) {
        const holder = await done(store.index('item').getKey(item));
        if (holder !== undefined && holder !== chrome) await done(store.delete(holder));
        await done(store.put({ chrome, item } satisfies IdRow));
      }
    }),
  remove: (ids: Iterable<ChromeId>): Promise<void> =>
    transact(['idmap'], 'readwrite', async (tx) => {
      const store = tx.objectStore('idmap');
      for (const chrome of ids) await done(store.delete(chrome));
    }),
};
