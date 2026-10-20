// Two locks: Helium's own (SingletonLock, or lockfile on Windows: is Helium running on this user data dir?) and
// the apply helper's pid file (is a helper already waiting for this user data dir?).
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, readlinkSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { currentOs, keyOf, type Os } from './paths.ts';

export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, under another user.
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

/** Whether no Helium holds `userDataDir`. Anything unexpected counts as running: never write on a guess. */
export function isHeliumClosed(userDataDir: string, os: Os = currentOs()): boolean {
  return os === 'win32' ? lockfileReleased(userDataDir) : singletonLockReleased(userDataDir);
}

/**
 * Windows: Helium holds `lockfile` open, sharing it for reading only, and deletes it as it exits. Opening it for
 * writing fails (EBUSY) while Helium runs; a file a crash left behind opens.
 */
function lockfileReleased(userDataDir: string): boolean {
  try {
    closeSync(openSync(join(userDataDir, 'lockfile'), 'r+'));
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
  }
}

/**
 * macOS and Linux: `SingletonLock` is gone, or its target `<host>-<pid>` names another host or a dead pid (the
 * link survives a crash, P1).
 */
function singletonLockReleased(userDataDir: string): boolean {
  let target: string;
  try {
    target = readlinkSync(join(userDataDir, 'SingletonLock'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true;
    throw error;
  }
  const dash = target.lastIndexOf('-');
  const pid = Number(target.slice(dash + 1));
  if (dash <= 0 || !Number.isInteger(pid)) return false;
  return target.slice(0, dash) !== hostname() || !isAlive(pid);
}

const helperLockPath = (home: string, userDataDir: string) => join(home, 'helpers', `${keyOf(userDataDir)}.pid`);

const lockHolder = (path: string): number | null => {
  try {
    return Number(readFileSync(path, 'utf8').trim());
  } catch {
    return null;
  }
};

export function isHelperRunning(home: string, userDataDir: string): boolean {
  const pid = lockHolder(helperLockPath(home, userDataDir));
  return pid !== null && isAlive(pid);
}

/** Take the helper lock for `userDataDir`, clearing a stale one. False when a live helper holds it. */
export function acquireHelperLock(home: string, userDataDir: string): boolean {
  const path = helperLockPath(home, userDataDir);
  mkdirSync(join(home, 'helpers'), { recursive: true });
  // Write the pid first, then hard-link it into place: the lock never exists without its holder.
  const temp = `${path}.${process.pid}`;
  writeFileSync(temp, String(process.pid), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(temp, path);
        return true;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
        const holder = lockHolder(path);
        if (holder === process.pid) return true;
        if (holder !== null && isAlive(holder)) return false;
        rmSync(path, { force: true });
      }
    }
    return false;
  } finally {
    rmSync(temp, { force: true });
  }
}

export function releaseHelperLock(home: string, userDataDir: string): void {
  const path = helperLockPath(home, userDataDir);
  if (lockHolder(path) === process.pid) unlinkSync(path);
}
