// LocalState over IndexedDB, plus the adapter-private stores that share the database. Structured clone
// stores Map and Set directly, so the register layer's Maps need no serialisation.
//
// Database `helium-sync`, version 1:
//   device        key 'me'                         DeviceLocal
//   registers     key type                         RegisterLocal
//   logCursor     key type                         LogCursor
//   logOwn        key [type, shard]                OwnShard
//   logPeer       key [type, device, shard]        PeerShard
//   ingested      key [type, eventKey]             echo guard
//   bookmarkIds   key chromeId, index itemId       IdMap
//   visits        key `${t}|${url}`, index t, device   view sink
//
// chrome.storage.local holds only what the UI reads directly: StoreConfig, Settings, and the last SyncReport.
// `unlimitedStorage` is in the manifest and `navigator.storage.persist()` is requested at install, so the
// browser does not evict a 50k-bookmark replica plus 90 days of shards under storage pressure.
import type { LocalState } from '../ports.ts';
import type { Registry } from '../registry.ts';
import type { IdMap } from './chrome-bookmarks.ts';

export function openDatabase(): Promise<IDBDatabase> {
  throw new Error('not implemented');
}

/** One transaction per `save` and per slot `put`. Minting the DeviceId on first `load` uses crypto.randomUUID(). */
export function idbLocalState<Reg extends Registry>(_db: IDBDatabase, _registry: Reg, _device: { readonly name: string }): LocalState<Reg> {
  throw new Error('not implemented');
}

export function idbIdMap(_db: IDBDatabase): IdMap {
  throw new Error('not implemented');
}
