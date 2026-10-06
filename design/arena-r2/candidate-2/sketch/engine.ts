// The deep module. The service worker calls `sync` and writes the report where the popup reads it.
// Ordering, merging, stamping, GC, idle handling, rollback checks, manifest publishing, shard expiry,
// offline fallback, and crash safety all live behind it.
import type { DeviceId, ShardId } from './model.ts';
import type { Clock, LocalState, Profile, Store, StoreFailure } from './ports.ts';
import type { Registry } from './registry.ts';
import type { Codec, Platform } from './store-format.ts';

export type EngineDeps<Reg extends Registry> = {
  readonly registry: Reg;
  readonly store: Store;
  readonly profile: Profile<Reg>;
  readonly local: LocalState<Reg>;
  readonly codec: Codec;
  readonly clock: Clock;
  readonly platform: Platform;
  readonly appVersion: string;
  readonly policy?: Partial<Policy>;
};

export type Policy = {
  /** A device whose manifest lastSeen is older than this is idle. Skipped by merge and GC, never deleted. */
  readonly idleAfterDays: number;
  /** Rewrite our manifest at least this often so peers do not see us as idle. */
  readonly heartbeatHours: number;
  /** `store.list('devices/')` finds new peers. Between discoveries, one conditional GET per known peer suffices. */
  readonly discoverEveryMinutes: number;
  readonly massDelete: { readonly minItems: number; readonly fraction: number };
};
export const defaultPolicy: Policy = {
  idleAfterDays: 90,
  heartbeatHours: 24,
  discoverEveryMinutes: 15,
  massDelete: { minItems: 20, fraction: 0.5 },
};

export type SyncOptions = {
  /** Compute and report everything. Write nothing to the store, the browser, or local state. */
  readonly dryRun?: boolean;
  /** Let a mass delete through. */
  readonly force?: boolean;
  /** Run device discovery now (the popup's Sync now; after pairing). */
  readonly discover?: boolean;
};

export interface Engine {
  /** One full cycle. Idempotent. Safe from an alarm, an event, or a button. The caller holds the Web Lock. */
  sync(opts?: SyncOptions): Promise<SyncReport>;
  /** Delete this device's files from the store (uninstall, or "forget this device"). Peers keep what it contributed. */
  forget(): Promise<void>;
}

export function createEngine<const Reg extends Registry>(_deps: EngineDeps<Reg>): Engine {
  throw new Error('not implemented');
}

// ---------- Report. Plain data; the service worker stores it and the popup renders it ----------

export type SyncReport = {
  readonly device: DeviceId;
  readonly at: number;
  readonly dryRun: boolean;
  /** Non-null when the store was unreachable: the cycle ran against cached peer copies and published nothing. */
  readonly offline: StoreFailure | null;
  readonly types: { readonly [type: string]: TypeOutcome };
  readonly peers: readonly Peer[];
  readonly warnings: readonly Warning[];
};

export type ChangeLine = { readonly op: 'add' | 'update' | 'remove'; readonly label: string };

export type TypeOutcome =
  | { readonly kind: 'synced'; readonly stamped: number; readonly published: boolean; readonly applied: readonly ChangeLine[] }
  /** Register type with items the browser would not accept. Recomputed every cycle, never queued. */
  | { readonly kind: 'partial'; readonly stamped: number; readonly published: boolean; readonly pending: readonly ChangeLine[] }
  /** Log type. */
  | { readonly kind: 'collected'; readonly events: number; readonly publishedShards: readonly ShardId[]; readonly ingested: number; readonly backfilling: boolean }
  | { readonly kind: 'blocked'; readonly why: Blocked };

export type Blocked =
  | { readonly kind: 'mass-delete'; readonly removed: number; readonly of: number }
  | { readonly kind: 'newer-type-version'; readonly peer: DeviceId; readonly version: number }
  /** Our own manifest in the store has a higher seq than we wrote. Another installation writes our DeviceId. */
  | { readonly kind: 'identity-clash' };

export type Warning =
  | { readonly kind: 'rollback'; readonly peer: DeviceId; readonly type: string; readonly seen: number; readonly got: number }
  | { readonly kind: 'unreadable'; readonly key: string; readonly detail: string }
  | { readonly kind: 'unknown-codec'; readonly peer: DeviceId; readonly codec: string }
  | { readonly kind: 'foreign-file'; readonly name: string }
  | { readonly kind: 'rejoined'; readonly previous: DeviceId };

export type Peer = { readonly device: DeviceId; readonly name: string; readonly platform: Platform; readonly lastSeen: number; readonly idle: boolean };

/*
 * sync(opts). The caller holds navigator.locks 'helium-sync:engine', so one cycle runs at a time.
 *
 *   me = local.load()
 *   if me.lastSeen older than idleAfterDays:                     // peers stopped merging us
 *     forget(); me = local.reset(); warn rejoined                 // new DeviceId, applied = null, adopt by content
 *
 *   ---- fetch phase (the only phase that reads the store; any StoreError here sets offline and uses cached copies)
 *   if opts.discover or last discovery older than discoverEveryMinutes:
 *     names = store.list('devices/'); parseKey each; unknown names warn foreign-file; new manifests join me.peers
 *   ours = store.get(manifest(me), null); ours.seq > me.manifestSeq      -> every type blocked identity-clash
 *   per peer p: store.get(manifest(p), p.manifestVersion)
 *     ok         parseManifest -> p.manifest, p.manifestVersion
 *     unchanged  keep p.manifest
 *     missing    p.manifest = null (device forgot itself)
 *   live = peers whose manifest.lastSeen is within idleAfterDays. Idle devices and self skip below.
 *
 *   ---- per type T, switch T.model (exhaustive):
 *
 *   registers (round 1's cycle, unchanged; `files` now come from each live peer's manifest entry):
 *     tl = local.registers(T).get() ?? fresh
 *     per live peer p with entry e = p.manifest.files[rel(T)]:
 *       e.hash == tl.peers[p].entry.hash              use lastGood (nothing to download)
 *       else store.get(registers(p,T)) -> open(bytes, codec, e) -> parseStateFile
 *         ok and seq >= tl.peers[p].seq               use it; it becomes p's lastGood
 *         unreadable / unknown codec / offline        use lastGood, warn
 *         seq < tl.peers[p].seq                       use lastGood, warn rollback
 *         newer type version                          blocked
 *       no entry and no lastGood                      p contributes nothing and an empty Acked, so GC waits for it
 *     remote  = mergeReplicas([tl.own, ...files])
 *     stamp   = tick(me.clock, now, newestStamp(remote))
 *     raw     = profile.registers(T).read(tl.applied)
 *     adopted = T.adopt({ local: raw, unclaimed: live remote items absent from raw and tl.applied, isKnown })
 *     if adopted.aliases nonempty and not dryRun: channel.bind(adopted.aliases)
 *     if massDelete(tl.applied, adopted.live) and not force:        blocked mass-delete
 *     merged  = foldLocalChanges(remote, tl.applied, adopted.live, stamp)
 *     merged  = collectGarbage(merged, [ackedOf(merged), ...one Acked per live peer])
 *     target  = materialize(merged, T.normalize)
 *     if dryRun: report diffLive(adopted.live, target); continue
 *     h = plaintextHash(encodeStateFile(merged))
 *     if h != me.pushed[rel(T)]: local.registers(T).put(own = merged, seq + 1); queue (rel(T), seal(StateFile), h)   // commit before upload
 *     if adopted.live != target: r = channel.apply({ current: adopted.live, target }); re-read
 *     applied = target only when the re-read equals target; else report partial with diffLive(re-read, target)
 *     local.registers(T).put(applied, peers)
 *
 *   log (new):
 *     ll = local.log(T)
 *     { events, cursor } = profile.log(T).collect(ll.cursor.get() ?? initial)
 *     group events by shardOf(t); per shard: own = ll.own.get(s); union by T.key; ll.own.put(s, own); dirty += s
 *     ll.cursor.put(cursor)                                                  // after own shards, so a crash re-collects, union dedupes
 *     per dirty shard s: h = plaintextHash(encodeShardFile(own)); if h != me.pushed[rel(T,s)]: queue (rel(T,s), seal(ShardFile), h)
 *     per own shard older than retentionDays: store.delete; drop from manifest; ll.own.delete
 *     per live peer p, per manifest entry (T, s) with e.hash != ll.peer(p).get(s)?.appliedHash:
 *       store.get(shard(p,T,s)) -> open -> parseShardFile; unreadable/offline: skip (next cycle)
 *       fresh = events whose key is not in ll.ingested(keys)
 *       profile.log(T).ingest(p, fresh); ll.markIngested(keys); ll.peer(p).put(s, { appliedHash: e.hash })   // sink first, then mark: a crash re-ingests, sinks are idempotent on key
 *     per ll.peer(p) shard absent from p's manifest: ll.peer(p).delete(s)   // peer expired it; ingested keys stay so it never echoes
 *
 *   ---- publish phase (skipped when offline or dryRun)
 *   for each queued (rel, bytes, h): store.put(key, bytes); files[rel] = { hash: bytesHash(bytes), bytes }
 *   if anything queued or deleted, or heartbeatHours elapsed:
 *     store.put(manifest(me), encodeManifest({ ..., seq: me.manifestSeq + 1, lastSeen: now, files }))
 *     local.save(manifestSeq + 1, lastSeen = now, pushed[rel] = h for each queued)                       // after the manifest, so a crash re-puts identical bytes
 *
 * Crash at any line converges. `applied` moves only after the browser provably equals it. Published bytes
 * are a pure function of (peer files, browser content, local state). A rerun finds observed == merged for
 * anything a crashed run already stamped or applied, so nothing is stamped twice. A manifest that points at
 * bytes a crash never uploaded fails the hash on the reader side and reads as "not yet".
 */
