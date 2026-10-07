// Full profile mode: settings, custom search engines, and addresses as three more register types, through the
// companion (a fake per device that lands staged changes at once). Off devices neither publish nor apply them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, readManifest, syncedPair, type Device } from './support/harness.ts';
import { itemId } from './support/fake-companion.ts';
import { ground } from './support/ground.ts';
import type { Json } from '../src/model.ts';
import type { SyncReport } from '../src/engine.ts';
import type { Address, SearchEngine, Setting } from '../src/profile-mode.ts';
import { keys } from '../src/store-format.ts';

const cycleReport = async (d: Device): Promise<Extract<SyncReport, { kind: 'cycle' }>> => {
  const report = await d.cycle();
  if (report.kind !== 'cycle') throw new Error(`expected a cycle, got ${report.kind}`);
  return report;
};
const pref = (value: Json): Setting => ({ kind: 'pref', value });
const engine = (keyword: string, url: string): SearchEngine => ({
  kind: 'engine',
  name: keyword,
  keyword,
  url,
  suggestUrl: '',
  faviconUrl: '',
  newTabUrl: '',
  imageUrl: '',
  alternateUrls: [],
  active: true,
});
const home: Address = { kind: 'address', languageCode: 'en', label: 'Home', tokens: [[3, 'Ada Lovelace', 0], [77, '1 Main St', 0]] };

const LANGS = itemId('intl.accept_languages');
const FONT = itemId('webkit.webprefs.default_font_size');
const both = { x: { profileOn: true }, y: { profileOn: true } } as const;

test('settings cross between two devices: a change, then a removal back to the default', async () => {
  const world = new World('icloud');
  const { x, y } = await syncedPair(world, both);
  x.companion.settings.rows.set(LANGS, pref('en-GB,en'));
  // A second pref: a read that comes back empty trips the mass-delete guard, like any register type.
  x.companion.settings.rows.set(FONT, pref(18));
  await world.converge();
  assert.deepEqual(y.companion.settings.rows.get(LANGS), pref('en-GB,en'));

  y.companion.settings.rows.set(LANGS, pref('fr'));
  await world.converge();
  assert.deepEqual(x.companion.settings.rows.get(LANGS), pref('fr'));

  x.companion.settings.rows.delete(LANGS);
  await world.converge();
  assert.equal(y.companion.settings.rows.has(LANGS), false);
  assert.equal((await cycleReport(y)).settings.kind, 'synced');
});

test('a joining device takes the group\'s values for paths it shares, and shares the rest', async () => {
  const world = new World('icloud');
  const { x, y } = await syncedPair(world, both);
  x.companion.settings.rows.set(LANGS, pref('en-GB,en'));
  await world.converge();

  const z = world.add('Z', { browser: ground(), profileOn: true });
  z.companion.settings.rows.set(LANGS, pref('de'));
  z.companion.settings.rows.set(FONT, pref(18));
  await z.setup();
  await world.converge();
  for (const d of [x, y, z]) {
    assert.deepEqual(d.companion.settings.rows.get(LANGS), pref('en-GB,en'), `${d.name} keeps the group's languages`);
    assert.deepEqual(d.companion.settings.rows.get(FONT), pref(18), `${d.name} has Z's font size`);
  }
});

test('an off device publishes no profile files and changes nothing; on again, its edits made meanwhile sync', async () => {
  const world = new World('icloud');
  const { x, y } = await syncedPair(world, both);
  x.companion.settings.rows.set(LANGS, pref('en-GB,en'));
  await world.converge();

  y.profileOn = false;
  y.companion.settings.rows.set(LANGS, pref('fr'));
  x.companion.settings.rows.set(FONT, pref(18));
  await world.converge();
  const manifest = await readManifest(world.cloud.files.get(keys.manifest(y.device))?.data, y.device);
  assert.deepEqual([...(manifest?.files.keys() ?? [])].filter((rel) => /settings|search-engines|addresses/.test(rel)), [], 'Y\'s profile files left its manifest');
  assert.deepEqual(x.companion.settings.rows.get(LANGS), pref('en-GB,en'), 'X keeps what it merged');
  assert.equal(y.companion.settings.rows.has(FONT), false, 'nothing applies while off');
  assert.equal((await cycleReport(y)).settings.kind, 'off');

  y.profileOn = true;
  await world.converge();
  assert.deepEqual(x.companion.settings.rows.get(LANGS), pref('fr'), 'Y\'s edit while off is a local edit');
  assert.deepEqual(y.companion.settings.rows.get(FONT), pref(18), 'Y caught up on X\'s');
});

test('a peer cannot plant a setting outside the allowlist', async () => {
  const world = new World('icloud');
  const { x, y } = await syncedPair(world, both);
  const forged = itemId('safebrowsing.enabled');
  // X's channel shows a pref the companion would never return, so X's own file carries it.
  const honest = x.profile.settings;
  x.profile = {
    ...x.profile,
    settings: { ...honest, read: async (previous) => new Map([...((await honest.read(previous)) ?? []), [forged, pref(false)]]) },
  };
  x.companion.settings.rows.set(LANGS, pref('en-GB,en'));
  await world.converge();
  assert.deepEqual(y.companion.settings.rows.get(LANGS), pref('en-GB,en'));
  assert.equal(y.companion.settings.rows.has(forged), false);
});

test('engines on both devices adopt by keyword and url: one engine, and the companion learns the alias', async () => {
  const world = new World('icloud');
  const gx = itemId('aaaaaaaa-0000-4000-8000-000000000001');
  const gy = itemId('bbbbbbbb-0000-4000-8000-000000000002');
  const gyOther = itemId('bbbbbbbb-0000-4000-8000-000000000003');
  const wiki = engine('w', 'https://en.wikipedia.org/w/index.php?search={searchTerms}');
  const x = world.add('X', { browser: ground(), profileOn: true });
  const y = world.add('Y', { browser: ground(), profileOn: true });
  x.companion.engines.rows.set(gx, wiki);
  y.companion.engines.rows.set(gy, wiki);
  y.companion.engines.rows.set(gyOther, engine('gh', 'https://github.com/search?q={searchTerms}'));
  await x.setup();
  await y.setup();
  await world.converge();
  assert.equal(x.companion.engines.rows.size, 2);
  assert.equal(y.companion.engines.rows.size, 2, 'no duplicate on join');
  assert.deepEqual(y.companion.binds, [{ profile: 'Default', type: 'search-engines', aliases: [[gy, gx]] }]);
});

test('addresses round-trip: added, edited, removed', async () => {
  const world = new World('icloud');
  const { x, y } = await syncedPair(world, both);
  const guid = itemId('cccccccc-0000-4000-8000-000000000001');
  const work = itemId('cccccccc-0000-4000-8000-000000000002');
  x.companion.addresses.rows.set(guid, home);
  x.companion.addresses.rows.set(work, { ...home, label: 'Work', tokens: [[77, '2 Side St', 0]] });
  await world.converge();
  assert.deepEqual(y.companion.addresses.synced()[0], [guid, home]);

  y.companion.addresses.rows.set(guid, { ...home, label: 'Home, new' });
  await world.converge();
  assert.equal(x.companion.addresses.rows.get(guid)?.label, 'Home, new');

  x.companion.addresses.rows.delete(guid);
  await world.converge();
  assert.deepEqual([...y.companion.addresses.rows.keys()], [work]);
});

test('an unchecked Web Data version sits engines and addresses out without deleting them; settings still sync', async () => {
  const world = new World('icloud');
  const { x, y } = await syncedPair(world, both);
  const guid = itemId('aaaaaaaa-0000-4000-8000-000000000001');
  x.companion.engines.rows.set(guid, engine('w', 'https://w.example/?q={searchTerms}'));
  await world.converge();

  x.companion.webData = 'unsupported';
  x.companion.settings.rows.set(LANGS, pref('fr'));
  await world.converge();
  const report = await cycleReport(x);
  assert.equal(report.searchEngines.kind, 'off');
  assert.equal(report.settings.kind, 'synced');
  assert.equal(y.companion.engines.rows.size, 1, 'the rows X could not read are not deletions');
  assert.deepEqual(y.companion.settings.rows.get(LANGS), pref('fr'));
});
