// The deep module. Frontends call createEngine() and a handful of methods; everything about
// ordering, crypto, merging, deferral and crash safety is behind them.
import type { DeviceId, TypeId } from "./ids.ts";
import type { Clock, LocalState, Profile, Store } from "./ports.ts";
import type { ChangeOf, LocalOf, MergedIds, Registry } from "./registry.ts";
import type { InviteToken, Vault } from "./vault.ts";

export interface EngineDeps<R extends Registry> {
  registry: R;
  vault: Vault;
  store: Store;
  profile: Profile<R>;
  state: LocalState;
  clock: Clock;
  /** Progress + prompts for any UI. Optional; a headless run just uses the returned report. */
  reporter?: (event: SyncEvent) => void;
}

export function createEngine<const R extends Registry>(_deps: EngineDeps<R>): Engine<R> {
  throw new Error("not implemented");
}

export interface SyncOptions {
  /** Compute and report everything, write nothing to the store or the profile. */
  dryRun?: boolean;
  /** Allow a SuspiciousChange (mass delete / empty read) through. */
  force?: boolean;
  /** Restrict to some types. Default: all in the registry. */
  only?: readonly TypeId[];
}

export interface Engine<R extends Registry> {
  /** One full cycle. Idempotent; safe to call from a timer, a file watcher or a button. */
  sync(opts?: SyncOptions): Promise<SyncReport>;
  status(): Promise<Status>;
  /** What other devices published for an observed type (tabs, extensions). */
  others<K extends keyof R & string>(type: K): Promise<ReadonlyMap<DeviceId, LocalOf<R[K]>>>;
  /** Pairing and membership, delegated to vault.ts so frontends need one import. */
  invite(): Promise<InviteToken>;
  revoke(devices: readonly DeviceId[]): Promise<void>;
  /** Re-run sync on store change, local profile change and browser exit, until aborted. */
  watch(signal: AbortSignal): Promise<void>;
}

/**
 * The cross-process frontend boundary: structured-cloneable in and out, nothing else.
 * CLI calls Engine in-process; the extension UI and desktop app call these over native messaging
 * or IPC to the process that owns the engine. Types here must stay JSON.
 */
export type EngineApi = Pick<Engine<Registry>, "sync" | "status" | "invite" | "revoke">;

// ---- Reports: plain data, safe to serialise ------------------------------------------------

export interface SyncReport {
  mode: "live" | "offline" | "read-only";
  note?: string;
  types: Record<string, TypeOutcome>;
  devices: { id: DeviceId; name: string; lastSeen: number | null; stale: boolean }[];
  warnings: string[]; // rollback detected, unreadable remote file kept at last good, conflicted copies seen
}
export type TypeOutcome =
  | { status: "synced"; published: number; applied: string[] }  // applied = Type.describe() lines
  | { status: "deferred"; pending: string[] }                    // read-only session, or browser started mid-apply
  | { status: "blocked"; reason: string }                        // SuspiciousChange, newer typeVersion, no channel
  | { status: "unchanged" };

export interface Status { vaultId: string; device: DeviceId; mode: SyncReport["mode"]; pending: Record<string, number>; lastSync: number | null }

export type SyncEvent =
  | { kind: "phase"; type: TypeId; phase: "read" | "fetch" | "merge" | "publish" | "apply" }
  | { kind: "pending-apply"; type: TypeId; changes: string[] };

// Type-level proof the profile and registry stay in step: a MergedType's change/local types flow
// through Channel without casts.
export type _Check<R extends Registry, K extends MergedIds<R>> = [LocalOf<R[K]>, ChangeOf<R[K]>];

/*
 * sync(), per type T, under state.lock():
 *
 *   session = profile.open()                           // mode decided once, running-check inside
 *   for each type:
 *     current   = session.channel(T).read()
 *     remote    = for each device d in store.list("devices/"): open(state key) -> StateFile
 *                   - keys.parse() strict; unauthenticated/short file => use last-good copy from LocalState
 *                   - seq < seenSeq[d]                 => ignore, warn "rollback"
 *                   - typeVersion > T.version          => blocked, publish nothing
 *     S         = T.merge([own, ...remote].map(f => f.state))
 *     applied   = state.get("applied/T")               // last Local we made the profile equal to; null on first join
 *     S2        = T.observe({ state: S, applied, current, stamp: Hlc.tick(...) })   // may throw SuspiciousChange
 *     S3        = T.gc(S2, min(acked over live devices))
 *     store.put(own key, vault.seal(StateFile{ seq+1, acked, state: S3 }))        // skipped if byte-equal to last publish
 *     target    = T.materialize(S3)
 *     changes   = T.diff(current, target)
 *     if changes.length == 0:               state.put("applied/T", current)
 *     else if channel.apply is absent:      report deferred           // NOT queued: next sync re-derives it
 *     else if apply(...) == "applied":      state.put("applied/T", target)
 *     else:                                 report deferred
 *
 * Crash anywhere is safe: `applied` advances only after the profile provably equals it, the store
 * write is a pure function of (remote files, current, applied), so a rerun converges to the same bytes.
 * Deferral needs no queue: pending work is always diff(current, materialize(merged)).
 */
