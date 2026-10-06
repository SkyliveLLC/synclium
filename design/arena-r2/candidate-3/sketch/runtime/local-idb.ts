// Device-private engine state in IndexedDB. Chosen over chrome.storage.local for three reasons:
// multi-record transactions (the commit-then-publish rule needs `own`, `seq`, and the clock to land together),
// structured clone (Maps and big replicas without JSON round trips), and no 10 MB cap (history shards).
// The manifest asks for `unlimitedStorage` so the browser does not evict it under disk pressure.
//
// One database, `helium-sync-state`. Single writer: the worker, inside the cycle lock. Pages never open it.
//   core     one record: DeviceCore
//   shards   key `${type}/${shard}`: ShardLocal
//   sched    one record: { requested, completed, failures }  (Counters)
// Losing this database (the user clears extension data) is a clean reinstall: new DeviceId, applied = null,
// first-join adoption. The old DeviceId idles out of its peers after 90 days.
import type { LocalState } from '../ports.ts';
import type { Registry } from '../registry.ts';
import type { Counters } from './scheduler.ts';

/** `commit` is one readwrite transaction over `core` and `shards`. Replicas are stored as Maps via structured clone. */
export function idbLocalState<const Reg extends Registry>(_registry: Reg, _opts: { readonly deviceName: () => string }): LocalState<Reg> {
  throw new Error('not implemented');
}

/** `request()` is a single readwrite transaction on `sched`, so concurrent events never lose an increment. */
export function idbCounters(): Counters {
  throw new Error('not implemented');
}
