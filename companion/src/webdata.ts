// The engine and address registers over a profile's `Web Data` SQLite file (schema of meta version 154, P9 Q4/Q5).
// Reads open it immutable, so they work while Helium holds it. Writes happen only from the apply helper, while
// Helium is closed, inside the caller's transaction.
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { addresses, searchEngines, WEB_DATA_VERSIONS, type Address, type SearchEngine } from '../../extension/src/profile-mode.ts';
import { isItemId, type ItemId } from '../../extension/src/model.ts';

export type WebDataStatus = 'ok' | 'unsupported';

/** Read-only, without taking or waiting for Helium's lock (P1). */
export function openImmutable(path: string): DatabaseSync {
  const url = pathToFileURL(path);
  url.search = 'immutable=1';
  return new DatabaseSync(url, { readOnly: true });
}

export function webDataStatus(db: DatabaseSync): WebDataStatus {
  const row = db.prepare("select value from meta where key = 'version'").get();
  return WEB_DATA_VERSIONS.includes(Number(row?.['value'])) ? 'ok' : 'unsupported';
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const int = (v: unknown): number => (typeof v === 'number' ? v : 0);

/** Chromium time: microseconds since 1601-01-01 UTC. */
const chromiumNow = (): bigint => BigInt(Date.now()) * 1000n + 11_644_473_600_000_000n;
const unixNow = (): number => Math.floor(Date.now() / 1000);

// A custom engine: not prepopulated, not a starter pack (@bookmarks, @tabs), not from policy.
const CUSTOM = 'prepopulate_id = 0 and starter_pack_id = 0 and created_by_policy = 0';
const ENGINE_COLUMNS = 'sync_guid, short_name, keyword, url, suggest_url, favicon_url, new_tab_url, image_url, alternate_urls, is_active';

// TemplateURLData::ActiveStatus: 0 unspecified (auto-added), 1 true, 2 false.
const ACTIVE = 1;
const INACTIVE = 2;

function alternateUrls(column: unknown): unknown[] {
  try {
    const parsed: unknown = JSON.parse(text(column) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Custom engines by local sync_guid, minus the default engine. Rows the contract would reject are left out. */
export function readEngines(db: DatabaseSync, defaultGuids: ReadonlySet<string>): Map<ItemId, SearchEngine> {
  const engines = new Map<ItemId, SearchEngine>();
  for (const row of db.prepare(`select ${ENGINE_COLUMNS} from keywords where ${CUSTOM} order by id`).all()) {
    const guid = text(row['sync_guid']);
    if (!isItemId(guid) || defaultGuids.has(guid)) continue;
    const engine = searchEngines.parseRecord({
      kind: 'engine',
      name: text(row['short_name']),
      keyword: text(row['keyword']),
      url: text(row['url']),
      suggestUrl: text(row['suggest_url']),
      faviconUrl: text(row['favicon_url']),
      newTabUrl: text(row['new_tab_url']),
      imageUrl: text(row['image_url']),
      alternateUrls: alternateUrls(row['alternate_urls']),
      active: row['is_active'] === ACTIVE,
    });
    if (engine !== null) engines.set(guid, engine);
  }
  return engines;
}

/** Local addresses (record_type 0) by guid, each with all its token rows. */
export function readAddresses(db: DatabaseSync): Map<ItemId, Address> {
  const tokens = db.prepare('select type, value, verification_status from address_type_tokens where guid = ? order by type');
  const found = new Map<ItemId, Address>();
  for (const row of db.prepare('select guid, language_code, label from addresses where record_type = 0 order by rowid').all()) {
    const guid = text(row['guid']);
    if (!isItemId(guid)) continue;
    const address = addresses.parseRecord({
      kind: 'address',
      languageCode: text(row['language_code']),
      label: text(row['label']),
      tokens: tokens.all(guid).map((t) => [int(t['type']), text(t['value']), int(t['verification_status'])]),
    });
    if (address !== null) found.set(guid, address);
  }
  return found;
}

/** What a write did. `conflict`: the row is not a custom engine, or is the default engine, so it was left alone. */
export type RowWrite = 'written' | 'conflict';

/** Insert or update the custom engine whose sync_guid is `guid`, with the column values Helium gives one (P9 Q4). */
export function putEngine(db: DatabaseSync, guid: ItemId, engine: SearchEngine, defaultGuids: ReadonlySet<string>): RowWrite {
  if (defaultGuids.has(guid)) return 'conflict';
  const rows = db.prepare(`select id, is_active, ${CUSTOM} as custom from keywords where sync_guid = ?`).all(guid);
  if (rows.some((row) => row['custom'] !== 1) || rows.length > 1) return 'conflict';
  const now = chromiumNow();
  const fields = [engine.name, engine.keyword, engine.faviconUrl, engine.url, engine.suggestUrl, engine.imageUrl, engine.newTabUrl, JSON.stringify(engine.alternateUrls)];
  const existing = rows[0];
  if (existing === undefined) {
    db.prepare(
      `insert into keywords (short_name, keyword, favicon_url, url, suggest_url, image_url, new_tab_url, alternate_urls, is_active,
        safe_for_autoreplace, originating_url, date_created, usage_count, input_encodings, prepopulate_id, created_by_policy, last_modified,
        sync_guid, search_url_post_params, suggest_url_post_params, image_url_post_params, last_visited, created_from_play_api,
        starter_pack_id, enforced_by_policy, featured_by_policy, url_hash)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '', ?, 0, '', 0, 0, ?, ?, '', '', '', 0, 0, 0, 0, 0, NULL)`,
    ).run(...fields, engine.active ? ACTIVE : INACTIVE, now, now, guid);
    return 'written';
  }
  // Keep "unspecified" for an inactive engine that was never explicitly deactivated.
  const isActive = engine.active ? ACTIVE : existing['is_active'] === ACTIVE ? INACTIVE : int(existing['is_active']);
  // url_hash is keychain-bound and its input unknown (P9 Q4); NULL is tolerated, a stale one is not better.
  db.prepare(
    `update keywords set short_name = ?, keyword = ?, favicon_url = ?, url = ?, suggest_url = ?, image_url = ?, new_tab_url = ?,
       alternate_urls = ?, is_active = ?, last_modified = ?, url_hash = NULL where id = ?`,
  ).run(...fields, isActive, now, int(existing['id']));
  return 'written';
}

export function deleteEngine(db: DatabaseSync, guid: ItemId, defaultGuids: ReadonlySet<string>): RowWrite {
  if (defaultGuids.has(guid)) return 'conflict';
  db.prepare(`delete from keywords where sync_guid = ? and ${CUSTOM}`).run(guid);
  return 'written';
}

/** Insert or update a local address and replace its token rows with the record's. */
export function putAddress(db: DatabaseSync, guid: ItemId, address: Address): RowWrite {
  const existing = db.prepare('select record_type from addresses where guid = ?').get(guid);
  if (existing !== undefined && existing['record_type'] !== 0) return 'conflict';
  const now = unixNow();
  if (existing === undefined) {
    db.prepare(
      `insert into addresses (guid, use_count, use_date, date_modified, language_code, label, initial_creator_id, record_type)
       values (?, 1, ?, ?, ?, ?, 70073, 0)`,
    ).run(guid, now, now, address.languageCode, address.label);
  } else {
    db.prepare('update addresses set language_code = ?, label = ?, date_modified = ? where guid = ?').run(address.languageCode, address.label, now, guid);
  }
  db.prepare('delete from address_type_tokens where guid = ?').run(guid);
  const token = db.prepare('insert into address_type_tokens (guid, type, value, verification_status) values (?, ?, ?, ?)');
  for (const [type, value, status] of address.tokens) token.run(guid, type, value, status);
  return 'written';
}

export function deleteAddress(db: DatabaseSync, guid: ItemId): RowWrite {
  const existing = db.prepare('select record_type from addresses where guid = ?').get(guid);
  if (existing === undefined) return 'written';
  if (existing['record_type'] !== 0) return 'conflict';
  db.prepare('delete from addresses where guid = ?').run(guid);
  db.prepare('delete from address_type_tokens where guid = ?').run(guid);
  return 'written';
}
