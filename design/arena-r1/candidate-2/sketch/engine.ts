// The one thing every frontend calls. CLI, daemon, desktop app, and (via the daemon) the extension UI all go
// through `Engine.sync()`. It knows nothing about folders, launchd, or argv.

import type { DataType, DeviceId, Fields } from './datatype.ts';
import type { LocalState } from './local.ts';
import type { ProfileDir, RunState } from './profile.ts';
import type { Store } from './store.ts';
import type { DeviceCard } from './wire.ts';

export type EngineDeps = {
  readonly store: Store;
  readonly profile: ProfileDir;
  readonly local: LocalState;
  readonly types: readonly DataType<Fields>[];
  readonly now?: () => number;
};

export type TypeReport = {
  readonly name: string;
  /** Items whose registers this device stamped in this pass (user edits pushed). */
  readonly pushed: number;
  /** Items that differ between the browser and the merged state and could not be applied (Helium running). */
  readonly pending: number;
  readonly applied: boolean;
  /** First-join only. */
  readonly adopted: number;
  /** Set when `write` threw SchemaUnsupported or BrowserStarted; the type was read and pushed but not applied. */
  readonly skippedWrite: string | null;
};

export type SyncReport = {
  readonly device: DeviceId;
  readonly helium: RunState;
  readonly devices: readonly DeviceCard[];
  readonly types: readonly TypeReport[];
  readonly startedAt: Date;
  readonly finishedAt: Date;
};

export type EngineEvents = { report: SyncReport; error: Error };

export class Engine {
  constructor(deps: EngineDeps) {}

  /**
   * One full pass over every enabled type. Idempotent; call it on every trigger.
   * Per type:
   *  1. remote = decode all devices/<id>/<type>.json.gz; S = mergeStates([...remote, own])
   *  2. snapshot = type.read(profile, baseline)            (Helium may be running)
   *  3. first join: aliases = type.adopt(snapshot, materialize(S)); snapshot = remapIds(...)
   *     else:       S = stampChanges(S, baseline, snapshot, type.fieldKeys, hlc.tick(maxStamp(S), now()))
   *  4. S = collectGarbage(S, devices); local.saveType({own: S, baseline: snapshot, aliases, pushedHash})
   *     then store.write(state) if hash changed, then store.write(device card)
   *  5. if apply !== 'never' and openForWrite() !== null:
   *       type.write(writable, materialize(S)); local.saveType({..., baseline: materialize(S), aliases: empty})
   *     else report pending = |diff(materialize(S), snapshot)|
   * Also: evict devices idle > 30d (remove their files; they re-join with adoption if they return).
   * Crash safety: step 4 commits locally before uploading; a retry re-uploads identical bytes (hash) and never
   * re-stamps, because baseline already equals what was pushed.
   */
  sync(opts?: { readonly apply?: 'if-closed' | 'never' }): Promise<SyncReport> {
    throw new Error('not implemented');
  }

  /** Cheap: local state + store listing + runState. No profile reads, no writes. */
  status(): Promise<SyncReport> {
    throw new Error('not implemented');
  }

  on<K extends keyof EngineEvents>(event: K, handler: (payload: EngineEvents[K]) => void): () => void {
    throw new Error('not implemented');
  }
}
