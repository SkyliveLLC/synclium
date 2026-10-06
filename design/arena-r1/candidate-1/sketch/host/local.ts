// Files this tool owns on the local machine. None of them are inside Helium's user-data dir, except the
// native-host manifest (cli/install.ts), which is Chromium's registration point for native hosts.

import type { ReplicaStore } from '../engine/engine.ts';
import type { Brand } from '../engine/model.ts';
import type { TransportConfig } from '../transports/folder.ts';

export type HeliumDataDir = Brand<string, 'HeliumDataDir'>;

export type Paths = {
  /** macOS `~/Library/Application Support/net.imput.helium` (observed). Linux/Windows unverified. */
  readonly helium: HeliumDataDir;
  /** `~/Library/Application Support/helium-sync` | `$XDG_CONFIG_HOME/helium-sync` | `%APPDATA%\helium-sync` */
  readonly home: string;
  /** home/config.json */
  readonly config: string;
  /** home/replicas/<DeviceId>.json: ReplicaState per device */
  readonly replicas: string;
  /** home/run/: control sockets */
  readonly run: string;
  /** home/extension/: unpacked companion, refreshed by every `setup` */
  readonly extension: string;
  /** home/host: shim Helium executes; pins the Node binary that ran `setup` */
  readonly hostShim: string;
};

export function resolvePaths(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Paths {
  throw new Error('not implemented');
}

/** v1: one store per user. Every profile that has the companion installed syncs to it. */
export type Config = { readonly v: 1; readonly store: TransportConfig; readonly label: string };

/** Parse at the boundary; a malformed file is an error naming the path, never a silent default. */
export async function loadConfig(paths: Paths): Promise<Config | null> {
  throw new Error('not implemented');
}
export async function saveConfig(paths: Paths, config: Config): Promise<void> {
  throw new Error('not implemented');
}

/** JSON file per device, atomic temp+rename writes. */
export function fileReplicaStore(paths: Paths): ReplicaStore {
  throw new Error('not implemented');
}
