// Writes rows into the CLOSED scratch profile's Web Data (SQLite), the way an offline file-mode applier would.
// Inserts: keyword p9a (url_hash NULL), keyword p9b (url_hash copied from another row = wrong),
// one address (addresses + address_type_tokens), two autocomplete entries, one card encrypted with the mock key.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createCipheriv } from 'node:crypto';
import { keyFor } from './oscrypt.mjs';
const db = new DatabaseSync('/tmp/helium-sync-scratch/p9-profile/profile/Default/Web Data', { readBigInts: true });
// Chromium time: microseconds since 1601-01-01 UTC.
const now = BigInt(Date.now()) * 1000n + 11644473600000000n;
const unixNow = Math.floor(Date.now() / 1000);
const wrongHash = db.prepare('select url_hash from keywords where id = 16').get().url_hash;
const kw = db.prepare(`insert into keywords (short_name, keyword, favicon_url, url, safe_for_autoreplace, date_created, input_encodings,
  prepopulate_id, last_modified, sync_guid, alternate_urls, is_active, url_hash) values (?, ?, '', ?, 0, ?, '', 0, ?, ?, '[]', 1, ?)`);
db.exec('begin');
kw.run('P9 Offline NullHash', 'p9a', 'https://p9a.example.test/?q={searchTerms}', now, now, randomUUID(), null);
kw.run('P9 Offline WrongHash', 'p9b', 'https://p9b.example.test/?q={searchTerms}', now, now, randomUUID(), wrongHash);
// Address: copy the token layout of the existing address, with new values.
const src = db.prepare('select guid from addresses limit 1').get().guid;
const guid = randomUUID();
db.prepare('insert into addresses (guid, use_count, use_date, date_modified, language_code, label, initial_creator_id, record_type) values (?, 1, ?, ?, \'\', \'\', 70073, 0)').run(guid, unixNow, unixNow);
const values = { 3: 'Robin', 5: 'Offline', 7: 'Robin Offline', 9: 'robin@example.test', 14: '+15125550111', 33: 'Denver', 34: 'CO', 35: '80202', 36: 'US', 77: '2 Offline Ave', 109: 'Offline' };
for (const t of db.prepare('select type, verification_status from address_type_tokens where guid = ?').all(src)) {
  db.prepare('insert into address_type_tokens (guid, type, value, verification_status) values (?, ?, ?, ?)').run(guid, t.type, values[Number(t.type)] ?? '', t.verification_status);
}
const ac = db.prepare('insert into autocomplete (name, label, label_normalized, value, value_lower, date_created, date_last_used, count) values (?, \'\', \'\', ?, ?, ?, ?, 1)');
ac.run('nickname', 'offline-nick', 'offline-nick', unixNow, unixNow);
ac.run('favcolor', 'offline-teal', 'offline-teal', unixNow, unixNow);
const c = createCipheriv('aes-128-cbc', keyFor('mock_password'), Buffer.alloc(16, ' '));
const enc = Buffer.concat([Buffer.from('v10'), c.update('5555555555554444'), c.final()]);
db.prepare('insert into credit_cards (guid, name_on_card, expiration_month, expiration_year, card_number_encrypted, date_modified, use_count, use_date, billing_address_id, nickname, is_user_confirmed) values (?, ?, 11, 2031, ?, ?, 0, ?, \'\', \'offline\', 0)').run(randomUUID(), 'Robin Offline', enc, unixNow, unixNow);
db.exec('commit');
db.close();
console.log('written; address', guid);
