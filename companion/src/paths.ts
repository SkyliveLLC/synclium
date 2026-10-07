// Where things live: Helium's user data dir, a profile inside it, and the companion's own home.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const COMPANION_VERSION = '0.1.0';
export const BINARY_NAME = 'helium-sync-companion';
export const DEFAULT_USER_DATA_DIR = join(homedir(), 'Library', 'Application Support', 'net.imput.helium');

/** `~/Library/Application Support/helium-sync-companion`, or `HELIUM_SYNC_COMPANION_HOME`. */
export function companionHome(env: NodeJS.ProcessEnv = process.env): string {
  return env['HELIUM_SYNC_COMPANION_HOME'] ?? join(homedir(), 'Library', 'Application Support', BINARY_NAME);
}

/** `--user-data-dir=` from a command line. Chromium's flag takes no quoting, so the value runs to the next ` --`. */
export function userDataDirFromCommand(command: string): string | null {
  return /--user-data-dir=(.+?)(?= --|$)/.exec(command.trim())?.[1] ?? null;
}

/**
 * The user data dir of the Helium that launched this host. A native host is not told it, so read the parent's
 * command line. `HELIUM_SYNC_USER_DATA_DIR` overrides (tests, the scratch check).
 */
export function launchingUserDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['HELIUM_SYNC_USER_DATA_DIR'];
  if (override !== undefined) return override;
  try {
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(process.ppid)], { encoding: 'utf8' });
    return userDataDirFromCommand(command) ?? DEFAULT_USER_DATA_DIR;
  } catch {
    return DEFAULT_USER_DATA_DIR;
  }
}

/** A profile is a directory name directly inside the user data dir ("Default", "Profile 1"), never a path. */
export function profileDir(userDataDir: string, profile: string): string {
  if (profile === '' || profile === '.' || profile === '..' || /[/\\\0]/.test(profile)) throw new Error(`not a profile directory name: ${profile}`);
  return join(userDataDir, profile);
}

/** Short stable key for a user data dir (and profile), used in companion file names. */
export function keyOf(...parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16);
}
