// One profile's files as the three registers see them, keyed by local id. The host reads through an immutable
// Web Data handle; the apply helper passes its writable one, so it checks `before` against what it will change.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ProfileTypeName, RecordOf } from '../../extension/src/profile-mode.ts';
import type { ItemId } from '../../extension/src/model.ts';
import { parseJsonRecord, type JsonRecord } from './json.ts';
import { defaultEngineGuids, readSettings } from './prefs.ts';
import { toSynced, type Aliases } from './state.ts';
import { readAddresses, readEngines, webDataStatus, type WebDataStatus } from './webdata.ts';

export type LocalRows = { readonly [T in ProfileTypeName]: ReadonlyMap<ItemId, RecordOf[T]> };

export type ProfileFiles = {
  readonly prefs: JsonRecord;
  readonly defaultGuids: ReadonlySet<string>;
  readonly webData: WebDataStatus;
  readonly local: LocalRows;
};

export const preferencesPath = (dir: string) => join(dir, 'Preferences');
export const webDataPath = (dir: string) => join(dir, 'Web Data');

export function readPreferences(dir: string): JsonRecord {
  return parseJsonRecord(readFileSync(preferencesPath(dir), 'utf8'), preferencesPath(dir));
}

function readSecurePreferences(dir: string): JsonRecord {
  const path = join(dir, 'Secure Preferences');
  return existsSync(path) ? parseJsonRecord(readFileSync(path, 'utf8'), path) : {};
}

/** `db` null: no Web Data yet, which reads as unsupported (rows wait). */
export function readProfileFiles(dir: string, db: DatabaseSync | null): ProfileFiles {
  const prefs = readPreferences(dir);
  const defaultGuids = defaultEngineGuids(prefs, readSecurePreferences(dir));
  const webData = db === null ? 'unsupported' : webDataStatus(db);
  const rows = db !== null && webData === 'ok';
  return {
    prefs,
    defaultGuids,
    webData,
    local: {
      settings: readSettings(prefs),
      'search-engines': rows ? readEngines(db, defaultGuids) : new Map(),
      addresses: rows ? readAddresses(db) : new Map(),
    },
  };
}

/** The rows by synced id. */
export function syncedRows(local: LocalRows, aliases: Aliases): LocalRows {
  return {
    settings: local.settings,
    'search-engines': toSynced(local['search-engines'], aliases['search-engines']),
    addresses: toSynced(local.addresses, aliases.addresses),
  };
}
