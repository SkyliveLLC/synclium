// The deep module. Frontends (CLI, daemon, later a desktop app or the native host) call `sync` and read
// a plain-JSON report. Ordering, merging, stamping, GC, eviction, rollback checks, deferral, and crash
// safety all live behind it.
import type { DeviceId, Rec } from './model.ts';
import type { Clock, LocalState, Profile, ProfileSession, ReadChannel, ReadOnlyReason, SessionMode, Store, WriteChannel } from './ports.ts';
import type { RecordOf, Registry, TypeName } from './registry.ts';
import type { Codec, Platform } from './store-format.ts';

export type EngineDeps<Reg extends Registry> = {
  readonly registry: Reg;
  readonly store: Store;
  readonly profile: Profile<Reg>;
  readonly local: LocalState<Reg>;
  /** The codec this device writes with. v1 has one. */
  readonly codec: Codec;
  readonly clock: Clock;
  readonly platform: Platform;
  readonly appVersion: string;
  readonly policy?: Partial<Policy>;
};

export type Policy = {
  /** A device whose meta.json is older than this is idle. Idle devices are skipped by merge and GC, never deleted. */
  readonly idleAfterDays: number;
  /** Rewrite our meta.json at least this often so peers do not see us as idle. */
  readonly heartbeatHours: number;
  readonly massDelete: { readonly minItems: number; readonly fraction: number };
};
export const defaultPolicy: Policy = { idleAfterDays: 90, heartbeatHours: 24, massDelete: { minItems: 20, fraction: 0.5 } };

export type SyncOptions = {
  /** Compute and report everything. Write nothing to the store, the profile, or local state. */
  readonly dryRun?: boolean;
  /** Let a mass delete through. */
  readonly force?: boolean;
};

export interface Engine {
  /** One full cycle. Idempotent. Safe from a timer, a watcher, or a button. `status` is `sync({ dryRun: true })`. */
  sync(opts?: SyncOptions): Promise<SyncReport>;
  /** Delete this device's files from the store (`uninstall --forget`). Peers keep everything it contributed. */
  forget(): Promise<void>;
}

export function createEngine<const Reg extends Registry>(_deps: EngineDeps<Reg>): Engine {
  throw new Error('not implemented');
}

// ---------- Report. Plain data, safe to serialise for any frontend ----------

export type SyncReport = {
  readonly device: DeviceId;
  readonly at: number;
  readonly dryRun: boolean;
  readonly mode: SessionMode;
  readonly types: { readonly [type: string]: TypeOutcome };
  readonly peers: readonly Peer[];
  readonly warnings: readonly Warning[];
};

export type ChangeLine = { readonly op: 'add' | 'update' | 'remove'; readonly label: string };

export type TypeOutcome =
  | { readonly kind: 'synced'; readonly stamped: number; readonly published: boolean; readonly applied: readonly ChangeLine[] }
  | {
      readonly kind: 'deferred';
      readonly stamped: number;
      readonly published: boolean;
      /** Recomputed every cycle as diff(current, materialize(merged)). Never queued. */
      readonly pending: readonly ChangeLine[];
      readonly why: ReadOnlyReason | { readonly kind: 'helium-started' };
    }
  /** Nothing published and nothing applied for this type. */
  | { readonly kind: 'blocked'; readonly why: Blocked };

export type Blocked =
  | { readonly kind: 'mass-delete'; readonly removed: number; readonly of: number }
  | { readonly kind: 'newer-type-version'; readonly peer: DeviceId; readonly version: number }
  /** Our own file in the store has a higher seq than we wrote. A copied state dir writes our DeviceId. */
  | { readonly kind: 'identity-clash' };

export type Warning =
  | { readonly kind: 'rollback'; readonly peer: DeviceId; readonly type: string; readonly seen: number; readonly got: number }
  | { readonly kind: 'unreadable'; readonly name: string; readonly detail: string }
  | { readonly kind: 'unknown-codec'; readonly peer: DeviceId; readonly codec: string }
  /** Conflict copies, temp files, placeholders. Reported, never merged. */
  | { readonly kind: 'foreign-file'; readonly name: string }
  | { readonly kind: 'rejoined'; readonly previous: DeviceId };

export type Peer = { readonly device: DeviceId; readonly name: string; readonly lastSeen: number; readonly idle: boolean };

// ---------- The one place the engine looks at session mode ----------

export type ApplyStep<R extends Rec> =
  | { readonly kind: 'apply'; readonly channel: WriteChannel<R> }
  | { readonly kind: 'defer'; readonly channel: ReadChannel<R>; readonly why: ReadOnlyReason };

export function channelFor<Reg extends Registry, K extends TypeName<Reg>>(session: ProfileSession<Reg>, type: K): ApplyStep<RecordOf<Reg[K]>> {
  switch (session.mode) {
    case 'offline':
    case 'live':
      return { kind: 'apply', channel: session.channel(type) };
    case 'read-only':
      return { kind: 'defer', channel: session.channel(type), why: session.why };
    default: {
      const unreachable: never = session;
      return unreachable;
    }
  }
}

/*
 * sync(opts), under local.lock():
 *
 *   me       = local.load()
 *   if me.lastSeen is older than idleAfterDays:     // we were idle; peers stopped merging us
 *     delete our old files; me = local.reset(); warn rejoined     // new DeviceId, applied = null, adopt by content
 *   names    = store.list("devices/"); parseKey each; unparsable names warn foreign-file
 *   metas    = parseMeta per device; idle = lastSeen older than idleAfterDays. Idle devices and self skip below.
 *   session  = profile.open()                                       // mode decided once per cycle
 *
 *   per type T in registry:
 *     tl      = me.types[T] ?? fresh
 *     files   = per live peer p: open(store.get(state(p, T))) then parseStateFile
 *                 ok and seq >= tl.peers[p].seq  use it; it becomes p's lastGood
 *                 unreadable or unknown codec    use tl.peers[p].lastGood, warn
 *                 seq < tl.peers[p].seq          use lastGood, warn rollback (the stale file could resurrect collected tombstones)
 *                 newer type version             blocked
 *                 no file and no lastGood        p contributes nothing and an empty Acked, so GC waits for it
 *     ours    = store.get(state(me, T)); seq > tl.seq                blocked identity-clash
 *     remote  = mergeReplicas([tl.own, ...files])
 *     stamp   = tick(me.clock, now, newestStamp(remote))
 *     raw     = channel.read(tl.applied)
 *     adopted = T.adopt({ local: raw, unclaimed: live remote items absent from raw and from tl.applied, isKnown })
 *     if adopted.aliases nonempty and not dryRun: channel.bind(adopted.aliases)
 *     if massDelete(tl.applied, adopted.live) and not force:         blocked mass-delete
 *     merged  = foldLocalChanges(remote, tl.applied, adopted.live, stamp)
 *     merged  = collectGarbage(merged, [ackedOf(merged), ...one Acked per live peer])   // every live peer, read or not
 *     target  = materialize(merged, T.normalize)
 *     if dryRun: report diffLive(adopted.live, target) and continue
 *
 *     h = plaintextHash(encodeStateFile(merged))
 *     if h != tl.pushedHash:
 *       local.save(own = merged, seq + 1, clock)                     // commit first, so a crash re-uploads and never re-stamps
 *       store.put(state(me, T), seal(StateFile))
 *       local.save(pushedHash = h)
 *     if adopted.live equals target:            applied = target
 *     else switch channelFor(session, T):
 *       defer                                   report pending = diffLive(adopted.live, target)
 *       apply   r = channel.apply({ current: adopted.live, target })
 *               r applied                       applied = target
 *               r deferred                      report pending; applied stays
 *     local.save(applied, peers)
 *
 *   if anything was published or heartbeatHours elapsed: store.put(meta(me), ...); local.save(lastSeen = now)
 *   session.close()
 *
 * Crash at any line converges. `applied` moves only after the profile provably equals it. Published bytes
 * are a pure function of (peer files, profile content, local state). A rerun finds observed == merged for
 * anything a crashed run already stamped or applied, so nothing is stamped twice.
 */
