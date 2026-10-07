// A throwaway Helium user data dir: Local State, one profile with Preferences, Secure Preferences, and a Web Data
// built from the P9 schema (meta version 154). Rows: two built-ins that are never synced, one custom engine, one
// custom engine that is the default, and one address.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isItemId, type ItemId } from '../../extension/src/model.ts';
import type { Address, SearchEngine } from '../../extension/src/profile-mode.ts';
import { parseJsonRecord, type JsonRecord } from '../src/json.ts';

const SCHEMA = `
CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
CREATE TABLE keywords (id INTEGER PRIMARY KEY,short_name VARCHAR NOT NULL,keyword VARCHAR NOT NULL,favicon_url VARCHAR NOT NULL,url VARCHAR NOT NULL,safe_for_autoreplace INTEGER,originating_url VARCHAR,date_created INTEGER DEFAULT 0,usage_count INTEGER DEFAULT 0,input_encodings VARCHAR,suggest_url VARCHAR,prepopulate_id INTEGER DEFAULT 0,created_by_policy INTEGER DEFAULT 0,last_modified INTEGER DEFAULT 0,sync_guid VARCHAR,alternate_urls VARCHAR,image_url VARCHAR,search_url_post_params VARCHAR,suggest_url_post_params VARCHAR,image_url_post_params VARCHAR,new_tab_url VARCHAR,last_visited INTEGER DEFAULT 0, created_from_play_api INTEGER DEFAULT 0, is_active INTEGER DEFAULT 0, starter_pack_id INTEGER DEFAULT 0, enforced_by_policy INTEGER DEFAULT 0, featured_by_policy INTEGER DEFAULT 0, url_hash BLOB);
CREATE TABLE addresses (guid VARCHAR PRIMARY KEY, use_count INTEGER NOT NULL DEFAULT 0, use_date INTEGER NOT NULL DEFAULT 0, date_modified INTEGER NOT NULL DEFAULT 0, language_code VARCHAR, label VARCHAR, initial_creator_id INTEGER DEFAULT 0, record_type INTEGER);
CREATE TABLE address_type_tokens (guid VARCHAR, type INTEGER, value VARCHAR, verification_status INTEGER DEFAULT 0, observations BLOB, PRIMARY KEY (guid, type));
INSERT INTO meta VALUES ('version', '154'), ('last_compatible_version', '151');
INSERT INTO keywords (short_name, keyword, favicon_url, url, safe_for_autoreplace, prepopulate_id, sync_guid, alternate_urls, is_active, starter_pack_id)
  VALUES ('Kagi', 'kagi.com', '', 'https://kagi.com/search?q={searchTerms}', 1, 115, '485bf7d3-0215-45af-87dc-538868000115', '[]', 0, 0),
         ('Tabs', '@tabs', '', 'chrome://tabs?q={searchTerms}', 1, 0, 'ec205736-edd7-4022-a9a3-b431fc000003', '[]', 1, 3),
         ('Docs', 'docs', '', 'https://docs.example.test/?q={searchTerms}', 0, 0, '11111111-1111-4111-8111-111111111111', '[]', 1, 0),
         ('Default Custom', 'dc', '', 'https://dc.example.test/?q={searchTerms}', 0, 0, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', '[]', 1, 0);
INSERT INTO addresses VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, 1791333675, 1791333675, '', '', 70073, 0);
INSERT INTO address_type_tokens (guid, type, value, verification_status) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 3, 'Pat', 1), ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 33, 'Austin', 4), ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 60, '', 0);
`;

export const DOCS = '11111111-1111-4111-8111-111111111111' as const;
export const DEFAULT_ENGINE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' as const;
export const ADDRESS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as const;

export const docsEngine: SearchEngine = {
  kind: 'engine',
  name: 'Docs',
  keyword: 'docs',
  url: 'https://docs.example.test/?q={searchTerms}',
  suggestUrl: '',
  faviconUrl: '',
  newTabUrl: '',
  imageUrl: '',
  alternateUrls: [],
  active: true,
};
export const patAddress: Address = { kind: 'address', languageCode: '', label: '', tokens: [[3, 'Pat', 1], [33, 'Austin', 4], [60, '', 0]] };

export const PREFERENCES = {
  browser: { window_placement: { left: 10, top: 20 } },
  default_search_provider: { guid: DEFAULT_ENGINE },
  download: { prompt_for_download: false, default_directory: '/Users/someone/Downloads' },
  helium: { browser: { show_back_button: false, tabs: { vertical: true } }, other: { x: 1 } },
  intl: { accept_languages: 'en-US,en' },
  profile: { exit_type: 'Normal', default_content_setting_values: { cookies: 4 } },
  spellcheck: { dictionaries: ['en-GB'] },
  sessions: { event_log: [{ time: '13435807193680770', type: 0 }] },
  extensions: { settings: { '16': { a: 1 }, '128': { b: '<script>' } } },
  webkit: { webprefs: { default_font_size: 18, default_fixed_font_size: 15 } },
};

export type Fixture = { readonly userDataDir: string; readonly home: string; readonly profileDir: string };

export function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'helium-sync-companion-'));
  const userDataDir = join(root, 'User Data');
  const profileDir = join(userDataDir, 'Default');
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(userDataDir, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Person 1' }, 'Profile 1': { name: 'Work' } } } }));
  writeFileSync(join(profileDir, 'Preferences'), JSON.stringify(PREFERENCES));
  writeFileSync(join(profileDir, 'Secure Preferences'), JSON.stringify({ homepage: 'https://example.test', protection: { macs: {} } }));
  const db = new DatabaseSync(join(profileDir, 'Web Data'));
  db.exec(SCHEMA);
  db.close();
  return { userDataDir, home: join(root, 'home'), profileDir };
}

export const readPrefs = (fixture: Fixture): JsonRecord => parseJsonRecord(readFileSync(join(fixture.profileDir, 'Preferences'), 'utf8'), 'Preferences');

/** Every keywords row, in id order, as plain objects (times included as bigint-safe strings). */
export function keywordRows(fixture: Fixture): unknown[] {
  const db = new DatabaseSync(join(fixture.profileDir, 'Web Data'), { readOnly: true, readBigInts: true });
  try {
    return db.prepare('select * from keywords order by id').all().map((row) => JSON.parse(JSON.stringify(row, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v))));
  } finally {
    db.close();
  }
}

export function item(id: string): ItemId {
  if (!isItemId(id)) throw new Error(`not an item id: ${id}`);
  return id;
}
