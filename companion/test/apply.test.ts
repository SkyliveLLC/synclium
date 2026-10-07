import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { Address, SearchEngine, StagedChanges } from '../../extension/src/profile-mode.ts';
import { applyOnce } from '../src/apply.ts';
import { handle } from '../src/host.ts';
import { loadStore, pendingCount } from '../src/state.ts';
import { ADDRESS, DEFAULT_ENGINE, DOCS, docsEngine, item, keywordRows, makeFixture, patAddress, PREFERENCES, readPrefs, type Fixture } from './fixture.ts';

const quiet = () => {};
const ctx = (fixture: Fixture) => ({ home: fixture.home, userDataDir: fixture.userDataDir, wakeHelper: quiet, log: quiet });
const none: StagedChanges = { settings: [], 'search-engines': [], addresses: [] };
const stage = (fixture: Fixture, changes: Partial<StagedChanges>) => handle(ctx(fixture), { kind: 'stage', profile: 'Default', changes: { ...none, ...changes } });
const read = (fixture: Fixture) => handle(ctx(fixture), { kind: 'read', profile: 'Default' });
const lockTo = (fixture: Fixture, pid: number) => {
  const lock = join(fixture.userDataDir, 'SingletonLock');
  rmSync(lock, { force: true });
  symlinkSync(`${hostname()}-${pid}`, lock);
};
const deadPid = () => spawnSync('true').pid;
const sql = (fixture: Fixture, statement: string) => {
  const db = new DatabaseSync(join(fixture.profileDir, 'Web Data'));
  db.exec(statement);
  db.close();
};

const NEW_ENGINE = item('33333333-3333-4333-8333-333333333333');
const NEW_ADDRESS = item('44444444-4444-4444-8444-444444444444');
const SYNCED_DOCS = item('22222222-2222-4222-8222-222222222222');
const wiki: SearchEngine = { ...docsEngine, name: 'Wiki', keyword: 'w', url: 'https://wiki.example.test/?s={searchTerms}', alternateUrls: ['https://wiki.example.test/#q={searchTerms}'] };
const robin: Address = { kind: 'address', languageCode: 'en', label: 'Home', tokens: [[3, 'Robin', 1], [33, 'Denver', 4]] };

test('waits while SingletonLock names a live pid, applies once it is dead', () => {
  const fixture = makeFixture();
  stage(fixture, { settings: [{ id: item('download.prompt_for_download'), before: { kind: 'pref', value: false }, after: { kind: 'pref', value: true } }] });
  const before = readFileSync(join(fixture.profileDir, 'Preferences'), 'utf8');

  lockTo(fixture, process.pid);
  assert.equal(applyOnce(fixture.home, fixture.userDataDir, quiet), 'running');
  assert.equal(readFileSync(join(fixture.profileDir, 'Preferences'), 'utf8'), before);

  lockTo(fixture, deadPid());
  assert.deepEqual(applyOnce(fixture.home, fixture.userDataDir, quiet), { applied: 1, skipped: 0 });
  assert.deepEqual(readPrefs(fixture), { ...PREFERENCES, download: { ...PREFERENCES.download, prompt_for_download: true } });
});

test('writes changes whose before still holds, skips ones the user changed, keeps every other key', () => {
  const fixture = makeFixture();
  handle(ctx(fixture), { kind: 'bind', profile: 'Default', type: 'search-engines', aliases: [[item(DOCS), SYNCED_DOCS]] });
  stage(fixture, {
    settings: [
      { id: item('helium.browser.show_back_button'), before: { kind: 'pref', value: false }, after: { kind: 'pref', value: true } },
      { id: item('intl.accept_languages'), before: { kind: 'pref', value: 'en-US,en' }, after: { kind: 'pref', value: 'de' } },
      { id: item('spellcheck.dictionaries'), before: { kind: 'pref', value: ['en-GB'] }, after: null },
    ],
    'search-engines': [
      { id: SYNCED_DOCS, before: docsEngine, after: { ...docsEngine, name: 'Docs 2' } },
      { id: NEW_ENGINE, before: null, after: wiki },
    ],
    addresses: [
      { id: item(ADDRESS), before: patAddress, after: { ...patAddress, tokens: [[3, 'Pat', 1], [33, 'Boston', 0]] } },
      { id: NEW_ADDRESS, before: null, after: robin },
    ],
  });
  // Meanwhile the user edits a language and the address in Helium.
  const edited = { ...PREFERENCES, intl: { accept_languages: 'fr' } };
  sql(fixture, `update address_type_tokens set value = 'Dallas' where guid = '${ADDRESS}' and type = 33`);
  writeFileSync(join(fixture.profileDir, 'Preferences'), JSON.stringify(edited));

  assert.deepEqual(applyOnce(fixture.home, fixture.userDataDir, quiet), { applied: 5, skipped: 2 });

  assert.deepEqual(readPrefs(fixture), { ...edited, spellcheck: {}, helium: { ...PREFERENCES.helium, browser: { ...PREFERENCES.helium.browser, show_back_button: true } } });

  const reread = read(fixture);
  assert.ok(reread.kind === 'state');
  assert.equal(reread.pending, 0);
  assert.deepEqual(reread.state['search-engines'], [
    [SYNCED_DOCS, { ...docsEngine, name: 'Docs 2' }],
    [NEW_ENGINE, wiki],
  ]);
  assert.deepEqual(reread.state.addresses, [
    [item(ADDRESS), { ...patAddress, tokens: [[3, 'Pat', 1], [33, 'Dallas', 4], [60, '', 0]] }],
    [NEW_ADDRESS, robin],
  ]);
  const docsRow = keywordRows(fixture).find((row) => typeof row === 'object' && row !== null && 'sync_guid' in row && row.sync_guid === DOCS);
  assert.ok(docsRow !== undefined, 'Docs keeps its local guid');
  assert.equal(pendingCount(loadStore(fixture.home, fixture.userDataDir, 'Default').pending), 0);
  assert.equal(readdirSync(join(fixture.home, 'backups')).length, 1);
});

test('the default engine row is never written', () => {
  const fixture = makeFixture();
  const rows = keywordRows(fixture);
  const dse: SearchEngine = { ...docsEngine, name: 'Default Custom', keyword: 'dc', url: 'https://dc.example.test/?q={searchTerms}' };
  stage(fixture, { 'search-engines': [{ id: item(DEFAULT_ENGINE), before: null, after: { ...dse, name: 'Hijacked' } }] });
  assert.deepEqual(applyOnce(fixture.home, fixture.userDataDir, quiet), { applied: 0, skipped: 1 });
  stage(fixture, { 'search-engines': [{ id: item(DEFAULT_ENGINE), before: dse, after: null }] });
  assert.deepEqual(applyOnce(fixture.home, fixture.userDataDir, quiet), { applied: 0, skipped: 1 });
  assert.deepEqual(keywordRows(fixture), rows);
});

test('an unsupported Web Data version leaves rows alone; settings still apply', () => {
  const fixture = makeFixture();
  sql(fixture, "update meta set value = '999' where key = 'version'");
  const rows = keywordRows(fixture);
  const reply = read(fixture);
  assert.ok(reply.kind === 'state');
  assert.equal(reply.webData, 'unsupported');
  assert.deepEqual([reply.state['search-engines'], reply.state.addresses], [[], []]);
  assert.equal(reply.state.settings.length, 8);

  stage(fixture, {
    settings: [{ id: item('download.prompt_for_download'), before: { kind: 'pref', value: false }, after: { kind: 'pref', value: true } }],
    'search-engines': [{ id: NEW_ENGINE, before: null, after: wiki }],
  });
  assert.deepEqual(applyOnce(fixture.home, fixture.userDataDir, quiet), { applied: 1, skipped: 1 });
  assert.deepEqual(keywordRows(fixture), rows);
});
