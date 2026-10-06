// The Helium profile on disk and the one rule of the file-first direction: write only while Helium is closed.
// The rule is encoded in types: `write` on a DataType takes a `WritableProfile`, and the only way to get one is
// `openForWrite`, which returns null while Helium runs and re-checks the lock before every rename.

export type ProfileDir = {
  readonly userDataDir: string; // macOS: ~/Library/Application Support/net.imput.helium
  readonly profile: string; // 'Default'
  /** Absolute path of a file inside the profile, e.g. file('Bookmarks'). */
  file(name: string): string;
};

/** Platform default, or the `--profile` override. Fails loudly if the directory has no `Local State`. */
export function locateProfile(override?: string): ProfileDir {
  // TODO linux ~/.config/net.imput.helium and win32 %LOCALAPPDATA%\imput\Helium\User Data are unverified (grounding).
  throw new Error('not implemented');
}

export type RunState = { readonly running: true; readonly pid: number } | { readonly running: false };

/**
 * P1: SingletonLock is a symlink to `<host>-<pid>` and survives SIGTERM/SIGKILL. Running means: link exists,
 * host === os.hostname(), pid alive, and pid's executable is the Helium binary (ps -o comm= / /proc/<pid>/exe).
 * Windows has no symlink lock; detection by process list filtered on --user-data-dir. Unverified.
 */
export function runState(profile: ProfileDir): Promise<RunState> {
  throw new Error('not implemented');
}

/** fs.watch on the user data dir for the lock plus a pid poll while running (the lock alone can lie). */
export function watchRunState(profile: ProfileDir, onChange: (state: RunState) => void): () => void {
  throw new Error('not implemented');
}

export class BrowserStarted extends Error {
  constructor() {
    super('Helium started during a profile write; remaining writes aborted');
  }
}

/** Capability to modify profile files. Exists only while Helium is closed. */
export interface WritableProfile {
  readonly dir: ProfileDir;
  /**
   * Backup current file to <localState>/backups/<iso>/<name>, write temp in the same directory, re-check
   * `runState`, rename. Throws `BrowserStarted` instead of renaming if Helium came up. One rename per file, so a
   * partially applied pass is whole files applied or not, never a torn one.
   */
  replace(name: string, bytes: Uint8Array): Promise<void>;
  /** For SQLite: copy to a scratch path so the adapter can open it read-write without touching the original until replace(). */
  scratchCopy(name: string): Promise<string>;
}

/**
 * Returns null while Helium is running. After the running-to-closed transition the caller should wait for the
 * pid to be gone and ~2s of file quiet: Chromium flushes Bookmarks and History on shutdown.
 */
export function openForWrite(profile: ProfileDir, backupDir: string): Promise<WritableProfile | null> {
  throw new Error('not implemented');
}

/** Read a profile file while Helium may be running. Bookmarks is rewritten atomically by Chromium, so a plain read is safe. */
export function readFile(profile: ProfileDir, name: string): Promise<Uint8Array> {
  throw new Error('not implemented');
}

export type Backup = { readonly takenAt: Date; readonly files: readonly string[] };
export function listBackups(backupDir: string): Promise<readonly Backup[]> {
  throw new Error('not implemented');
}
/** Needs a WritableProfile: restoring while Helium runs would be clobbered, same as any other write. */
export function restoreBackup(profile: WritableProfile, backup: Backup): Promise<void> {
  throw new Error('not implemented');
}
