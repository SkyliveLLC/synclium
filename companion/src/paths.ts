// Where things live, per OS: Helium's user data dir, a profile inside it, and the companion's own home.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';

export const BINARY_NAME = 'helium-sync-companion';

/** The systems the companion runs on, as `process.platform` names them. */
export type Os = 'darwin' | 'linux' | 'win32';

export function currentOs(): Os {
  const { platform } = process;
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32') return platform;
  throw new Error(`the companion does not run on ${platform}`);
}

/** What the per-OS paths depend on. Tests pass their own; everything else uses this process's. */
export type Place = { readonly os: Os; readonly env: NodeJS.ProcessEnv; readonly home: string };
const here = (): Place => ({ os: currentOs(), env: process.env, home: homedir() });

const localAppData = ({ env, home }: Place) => env['LOCALAPPDATA'] ?? win32.join(home, 'AppData', 'Local');

/** The installed binary's file name. */
export const binaryFile = (os: Os = currentOs()) => (os === 'win32' ? `${BINARY_NAME}.exe` : BINARY_NAME);

/** Helium's user data dir when it runs without `--user-data-dir`. */
export function defaultUserDataDir(place: Place = here()): string {
  const { os, env, home } = place;
  switch (os) {
    case 'darwin':
      return posix.join(home, 'Library', 'Application Support', 'net.imput.helium');
    case 'linux':
      return posix.join(env['XDG_CONFIG_HOME'] || posix.join(home, '.config'), 'net.imput.helium');
    case 'win32':
      return win32.join(localAppData(place), 'imput', 'Helium', 'User Data');
  }
}

/** The companion's state, log, backups, and installed binary. `HELIUM_SYNC_COMPANION_HOME` overrides. */
export function companionHome(place: Place = here()): string {
  const { os, env, home } = place;
  const override = env['HELIUM_SYNC_COMPANION_HOME'];
  if (override !== undefined) return override;
  switch (os) {
    case 'darwin':
      return posix.join(home, 'Library', 'Application Support', BINARY_NAME);
    case 'linux':
      return posix.join(env['XDG_DATA_HOME'] || posix.join(home, '.local', 'share'), BINARY_NAME);
    case 'win32':
      return win32.join(localAppData(place), BINARY_NAME);
  }
}

/**
 * `--user-data-dir=` from a command line. POSIX Chromium's flag takes no quoting, so the value runs to the next
 * ` --`; a Windows command line quotes a value with spaces, around the value or the whole switch.
 */
export function userDataDirFromCommand(command: string): string | null {
  const quoted = /"--user-data-dir=([^"]+)"|--user-data-dir="([^"]+)"/.exec(command);
  if (quoted !== null) return quoted[1] ?? quoted[2] ?? null;
  return /--user-data-dir=(.+?)(?= --|$)/.exec(command.trim())?.[1] ?? null;
}

/** The command line of the Helium that launched this host: the parent, or on Windows the parent of `cmd.exe`. */
function launcherCommand(os: Os): string {
  if (os !== 'win32') return execFileSync('ps', ['-o', 'command=', '-p', String(process.ppid)], { encoding: 'utf8' });
  // Helium starts a host through `cmd.exe /d /s /c`, unless a policy launches it directly.
  const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${process.ppid}"; if ($p.Name -ieq 'cmd.exe') { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" }; $p.CommandLine`;
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
}

/**
 * The user data dir of the Helium that launched this host. A native host is not told it, so read the launcher's
 * command line. `HELIUM_SYNC_USER_DATA_DIR` overrides (tests, the scratch check).
 */
export function launchingUserDataDir(place: Place = here()): string {
  const override = place.env['HELIUM_SYNC_USER_DATA_DIR'];
  if (override !== undefined) return override;
  try {
    return userDataDirFromCommand(launcherCommand(place.os)) ?? defaultUserDataDir(place);
  } catch {
    return defaultUserDataDir(place);
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
