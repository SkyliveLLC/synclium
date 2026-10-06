// This device's private state. Lives outside the profile and outside the store:
//   macOS ~/Library/Application Support/helium-sync/, Linux $XDG_STATE_HOME/helium-sync/
//   config.json, hlc.json, types/<name>.json, backups/<iso>/<file>, daemon.sock
// Each file is written temp+rename, so a crash leaves the previous committed value.

import type { DataType, DeviceId, DeviceState, Fields, ItemId, Snapshot } from './datatype.ts';
import type { Hlc } from './merge.ts';

export type Config = {
  readonly deviceId: DeviceId;
  readonly deviceName: string;
  readonly storeRoot: string; // FolderStore for v1; a later transport adds a discriminated `store` union here
  readonly profileDir: string | null; // null = platform default
  readonly types: readonly string[]; // enabled registry names
};

/** Per-type local state. The three fields are committed together; see Engine.sync step 4. */
export type TypeLocal<F extends Fields> = {
  /** The full merged state we last intended the store to hold (our device file). */
  readonly own: DeviceState<F>;
  /** What the browser showed when we last read or wrote it. null = never synced this type (first join). */
  readonly baseline: Snapshot<F> | null;
  /** local id -> sync id, from adoption, until a closed-window write rewrites the browser's ids and this empties. */
  readonly aliases: ReadonlyMap<ItemId, ItemId>;
  /** contentHash of the bytes last confirmed written to the store; skip the upload when unchanged. */
  readonly pushedHash: string | null;
};

export interface LocalState {
  readonly dir: string;
  readonly config: Config;
  readonly hlc: Hlc;
  readonly backupDir: string;
  readonly controlSocket: string;
  loadType<F extends Fields>(type: DataType<F>): Promise<TypeLocal<F>>;
  /** Atomic. Also persists the HLC so a stamp is never reissued after a crash. */
  saveType<F extends Fields>(type: DataType<F>, value: TypeLocal<F>): Promise<void>;
  saveConfig(config: Config): Promise<void>;
}

/** Fails if `init` has not run; the CLI turns that into "run helium-sync init <folder> first". */
export function openLocalState(dir?: string): Promise<LocalState> {
  throw new Error('not implemented');
}

/** First run: mint a DeviceId, pick a name (hostname), write config. Idempotent if config already exists. */
export function initLocalState(config: Omit<Config, 'deviceId'> & { deviceId?: DeviceId }, dir?: string): Promise<LocalState> {
  throw new Error('not implemented');
}
