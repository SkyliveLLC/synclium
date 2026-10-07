// The apply helper: waits until Helium has quit, then writes staged changes into the profile files. One per user
// data dir, and it handles every profile of that dir with staged changes. A change is written only while the file
// still holds its `before`; otherwise the user changed the value meanwhile and the change is dropped.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import type { StagedChange } from '../../extension/src/profile-mode.ts';
import type { ItemId } from '../../extension/src/model.ts';
import { writeFileAtomic } from './json.ts';
import { acquireHelperLock, isHeliumClosed, releaseHelperLock } from './lock.ts';
import type { Log } from './log.ts';
import { profileDir } from './paths.ts';
import { withSetting } from './prefs.ts';
import { preferencesPath, readProfileFiles, syncedRows, webDataPath } from './profile.ts';
import { loadStore, localIdOf, pendingStores, saveStore, stillHolds, withoutHandled, type ProfileStore } from './state.ts';
import { deleteAddress, deleteEngine, putAddress, putEngine, type RowWrite } from './webdata.ts';

export const POLL_MS = 2000;
const BACKUPS_KEPT = 5;

export type Tally = { readonly applied: number; readonly skipped: number };
const add = (a: Tally, b: Tally): Tally => ({ applied: a.applied + b.applied, skipped: a.skipped + b.skipped });

/** Write each row change whose `before` the table still holds, through its local id. */
function applyRows<R>(
  changes: readonly StagedChange<R>[],
  current: ReadonlyMap<ItemId, R>,
  aliases: ReadonlyMap<ItemId, ItemId>,
  put: (guid: ItemId, record: R) => RowWrite,
  remove: (guid: ItemId) => RowWrite,
): Tally {
  let tally: Tally = { applied: 0, skipped: 0 };
  for (const change of changes) {
    const guid = localIdOf(change.id, aliases);
    const written = stillHolds(current, change) && (change.after === null ? remove(guid) : put(guid, change.after)) === 'written';
    tally = add(tally, written ? { applied: 1, skipped: 0 } : { applied: 0, skipped: 1 });
  }
  return tally;
}

/** Apply one profile's staged changes. The caller has made sure Helium is closed. */
export function applyProfile(store: ProfileStore): Tally {
  const dir = profileDir(store.userDataDir, store.profile);
  const db = existsSync(webDataPath(dir)) ? new DatabaseSync(webDataPath(dir)) : null;
  try {
    const files = readProfileFiles(dir, db);
    const current = syncedRows(files.local, store.aliases);
    const { pending, aliases } = store;

    let rows: Tally = { applied: 0, skipped: pending['search-engines'].length + pending.addresses.length };
    if (db !== null && files.webData === 'ok') {
      db.exec('begin immediate');
      try {
        rows = add(
          applyRows(pending['search-engines'], current['search-engines'], aliases['search-engines'], (guid, engine) => putEngine(db, guid, engine, files.defaultGuids), (guid) => deleteEngine(db, guid, files.defaultGuids)),
          applyRows(pending.addresses, current.addresses, aliases.addresses, (guid, address) => putAddress(db, guid, address), (guid) => deleteAddress(db, guid)),
        );
        db.exec('commit');
      } catch (error) {
        db.exec('rollback');
        throw error;
      }
    }

    let prefs = files.prefs;
    let settings: Tally = { applied: 0, skipped: 0 };
    for (const change of pending.settings) {
      const next = stillHolds(current.settings, change) ? withSetting(prefs, change.id, change.after === null ? undefined : change.after.value) : null;
      if (next !== null) prefs = next;
      settings = add(settings, next === null ? { applied: 0, skipped: 1 } : { applied: 1, skipped: 0 });
    }
    if (prefs !== files.prefs) writeFileAtomic(preferencesPath(dir), JSON.stringify(prefs));

    return add(rows, settings);
  } finally {
    db?.close();
  }
}

/** Copy each profile's Preferences and Web Data to `backups/<time>/<profile>/`, keeping the newest few backups. */
function backup(home: string, stores: readonly ProfileStore[], now: Date): void {
  const root = join(home, 'backups');
  const stamp = now.toISOString().replaceAll(':', '-');
  for (const store of stores) {
    const dir = profileDir(store.userDataDir, store.profile);
    const into = join(root, stamp, store.profile);
    mkdirSync(into, { recursive: true });
    for (const name of ['Preferences', 'Web Data', 'Web Data-journal']) {
      if (existsSync(join(dir, name))) copyFileSync(join(dir, name), join(into, name));
    }
  }
  for (const old of readdirSync(root).sort().slice(0, -BACKUPS_KEPT)) rmSync(join(root, old), { recursive: true, force: true });
}

/**
 * One attempt: 'running' while Helium holds the user data dir, else back up and apply every profile's staged
 * changes, then clear them from its state. A profile that fails keeps its changes for a later helper.
 */
export function applyOnce(home: string, userDataDir: string, log: Log, now = new Date()): 'running' | Tally {
  if (!isHeliumClosed(userDataDir)) return 'running';
  const stores = pendingStores(home, userDataDir);
  if (stores.length === 0) return { applied: 0, skipped: 0 };
  backup(home, stores, now);
  if (!isHeliumClosed(userDataDir)) return 'running';
  let tally: Tally = { applied: 0, skipped: 0 };
  for (const store of stores) {
    try {
      const result = applyProfile(store);
      log(`applied ${result.applied}, skipped ${result.skipped} in ${store.profile}`);
      tally = add(tally, result);
    } catch (error) {
      log(`apply failed in ${store.profile}: ${error instanceof Error ? error.stack : String(error)}`);
      continue;
    }
    // Re-read: `stage` may have replaced a change while this one was written.
    const latest = loadStore(home, userDataDir, store.profile);
    const { settings, 'search-engines': engines, addresses } = store.pending;
    saveStore(home, {
      ...latest,
      pending: {
        settings: withoutHandled(latest.pending.settings, settings),
        'search-engines': withoutHandled(latest.pending['search-engines'], engines),
        addresses: withoutHandled(latest.pending.addresses, addresses),
      },
    });
  }
  return tally;
}

/** Poll until Helium is closed and apply once; 'empty' when there was nothing to wait for. */
async function waitAndApply(home: string, userDataDir: string, log: Log, pollMs: number): Promise<'applied' | 'empty'> {
  for (;;) {
    if (pendingStores(home, userDataDir).length === 0) return 'empty';
    const result = applyOnce(home, userDataDir, log);
    if (result !== 'running') return 'applied';
    await sleep(pollMs);
  }
}

/** The `apply` subcommand. Exits after one apply, or at once when nothing is staged or another helper waits. */
export async function runApplyHelper(home: string, userDataDir: string, log: Log, pollMs = POLL_MS): Promise<void> {
  for (;;) {
    if (!acquireHelperLock(home, userDataDir)) return log('another helper is waiting for this user data dir');
    let outcome: 'applied' | 'empty';
    try {
      outcome = await waitAndApply(home, userDataDir, log, pollMs);
    } finally {
      releaseHelperLock(home, userDataDir);
    }
    // A stage that saw this helper's lock just before it saw nothing pending would otherwise go unapplied.
    if (outcome === 'applied' || pendingStores(home, userDataDir).length === 0) return log(`helper done (${outcome})`);
  }
}
