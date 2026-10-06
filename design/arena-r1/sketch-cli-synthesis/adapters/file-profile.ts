// Profile over Helium's user-data dir. v1's only profile adapter. Owns the one rule of this adapter:
// profile files are written only while Helium is closed. The rule is a capability, not a convention.
import type { Brand } from '../model.ts';
import type { Profile } from '../ports.ts';
import type { HeliumRegistry } from '../registry.ts';
import type { Platform } from '../store-format.ts';

export type HeliumPaths = {
  /** macOS `~/Library/Application Support/net.imput.helium` (observed). Linux and Windows unverified. */
  readonly userDataDir: string;
  /** "Default" unless overridden. */
  readonly profile: string;
};

/** Platform default or `--profile`. Throws with the path it tried when there is no `Local State` file. */
export function locateHelium(_platform: Platform, _home: string, _override: string | null): HeliumPaths {
  throw new Error('not implemented');
}

// ---------- Run state ----------

export type RunState = { readonly kind: 'running'; readonly pid: number } | { readonly kind: 'closed' };

/**
 * P1. `SingletonLock` is a symlink to `<host>-<pid>` and survives SIGTERM and SIGKILL, so the link alone lies.
 * Running = link exists AND host is this machine AND pid is alive AND pid's executable is the Helium binary.
 */
export function runState(_paths: HeliumPaths): Promise<RunState> {
  throw new Error('not implemented');
}

export type ProfileEvent = { readonly kind: 'run-state'; readonly state: RunState } | { readonly kind: 'changed'; readonly file: ProfileFile };

/** One fs.watch on the user-data dir plus a pid poll while running. Feeds the daemon. */
export function watchHelium(_paths: HeliumPaths, _onEvent: (e: ProfileEvent) => void): { close(): void } {
  throw new Error('not implemented');
}

// ---------- The write capability ----------

/** v1 writes exactly one profile file. History joins this union when it ships. */
export type ProfileFile = 'Bookmarks';

const writable = Symbol('writable');

/**
 * Proof that Helium was closed when this was issued. The key is a module-private symbol, so no other
 * module can construct one. The file adapter's channels use it internally. The engine never sees it.
 */
export interface WritableProfile {
  readonly [writable]: true;
  readonly paths: HeliumPaths;
  /**
   * Backup to `<backups>/<iso>/<file>`, write a temp file beside the target, re-check run state, rename,
   * re-check run state again.
   * If Helium runs before the rename, nothing is renamed and the result is `helium-started`.
   * If Helium runs after the rename, it may have loaded either file, so the result is `helium-started` too.
   * The caller reports deferred and the next cycle sees which file won. There is no restore, because that
   * would be a second racy write.
   */
  replace(file: ProfileFile, bytes: Uint8Array): Promise<{ readonly kind: 'replaced' } | { readonly kind: 'helium-started' }>;
}

/** null while Helium runs. */
export function openForWrite(_paths: HeliumPaths, _backupDir: string): Promise<WritableProfile | null> {
  throw new Error('not implemented');
}

// ---------- Backups and restore ----------

export type BackupId = Brand<string, 'BackupId'>;
export type Backup = { readonly id: BackupId; readonly takenAt: number; readonly file: ProfileFile };

/** Newest first. Keeps the last 20 per file. */
export function listBackups(_backupDir: string): Promise<readonly Backup[]> {
  throw new Error('not implemented');
}

/**
 * Needs the capability, because a restore while Helium runs would be clobbered like any other write.
 * The restored content becomes local truth. The next sync stamps it and it propagates like an edit.
 */
export function restoreBackup(_w: WritableProfile, _backup: Backup): Promise<void> {
  throw new Error('not implemented');
}

// ---------- The adapter ----------

/**
 * open():
 *   w = openForWrite(paths, backupDir)
 *   w is null   read-only session ({ kind: 'helium-running', pid }), channels from bookmarksChannel(files)
 *   otherwise   offline session, channels from bookmarksChannel(files, w)
 * Reading is safe either way, because Chromium replaces Bookmarks atomically.
 * `stateDir` holds the adapter's own alias table, separate from engine state.
 */
export function fileProfile(_opts: { readonly paths: HeliumPaths; readonly backupDir: string; readonly stateDir: string }): Profile<HeliumRegistry> {
  throw new Error('not implemented');
}
