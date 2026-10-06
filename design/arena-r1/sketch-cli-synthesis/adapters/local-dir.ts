// Files this tool owns on this machine. None live inside Helium's user-data dir.
//   macOS  ~/Library/Application Support/helium-sync/
//   Linux  $XDG_STATE_HOME/helium-sync/ (unverified)
import type { LocalState } from '../ports.ts';
import type { Registry } from '../registry.ts';
import type { Platform } from '../store-format.ts';
import type { FolderPath } from './folder-store.ts';

export type Paths = {
  readonly home: string;
  /** config.json, the CLI's bindings. */
  readonly config: string;
  /** state.json, the engine's DeviceLocal. */
  readonly state: string;
  /** sync.lock, pid inside, taken over when the pid is dead. */
  readonly lock: string;
  /** backups/<iso>/<file>, written before every profile replace. */
  readonly backups: string;
  /** adapter/, adapter-private state such as the bookmark alias table. */
  readonly adapter: string;
  /** daemon.log */
  readonly log: string;
};

export function resolvePaths(_platform: Platform, _env: { readonly [name: string]: string | undefined }): Paths {
  throw new Error('not implemented');
}

/** What `init` binds. A later transport adds a member to `store`, and every switch on it fails to compile until handled. */
export type Config = {
  readonly v: 1;
  readonly store: { readonly kind: 'folder'; readonly path: FolderPath };
  readonly profileOverride: string | null;
};

/** Boundary parse. A malformed file is an error naming the path, never a silent default. */
export function loadConfig(_paths: Paths): Promise<Config | null> {
  throw new Error('not implemented');
}
export function saveConfig(_paths: Paths, _config: Config): Promise<void> {
  throw new Error('not implemented');
}

/** LocalState over state.json and sync.lock. Parses per-type state through the registry's types. */
export function localDir<Reg extends Registry>(_paths: Paths, _registry: Reg, _device: { readonly name: string }): LocalState<Reg> {
  throw new Error('not implemented');
}
