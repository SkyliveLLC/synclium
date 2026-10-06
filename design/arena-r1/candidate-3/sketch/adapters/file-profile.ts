// Profile over the Helium user-data dir. Works for everyone with no install; v1's only profile adapter.
import type { Profile } from "../ports.ts";
import type { HeliumRegistry } from "../index.ts";

export interface FileProfileOptions {
  /** macOS: ~/Library/Application Support/net.imput.helium; Linux/Windows paths unverified, so always overridable. */
  userDataDir: string;
  profile: string; // "Default"
  /** Where to keep our own timestamped backups of any file we replace (device state dir, not the profile). */
  backupDir: string;
}

/**
 * open():
 *   running = SingletonLock -> "<host>-<pid>", host matches, pid alive, pid is the Helium binary.
 *   not running -> mode "offline": read + apply on Bookmarks.
 *   running     -> mode "read-only" (or "live" when live-profile wraps this): read still works because
 *                  Chromium replaces the file atomically; apply is absent.
 *
 * Bookmarks apply(): back up, rebuild JSON from `target` while keeping existing nodes' id, date_added and
 * meta_info and preserving guids (new nodes get guid = ItemId, date_added = now), recompute the MD5
 * checksum, write temp + rename, then re-check the lock. If Helium started meanwhile, restore the backup
 * and return "deferred": the engine's `applied` does not advance, so the next cycle redoes it.
 * Never writes any other profile file.
 */
export function fileProfile(_opts: FileProfileOptions): Profile<HeliumRegistry> {
  throw new Error("not implemented");
}
