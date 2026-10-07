// Full profile mode on the real surface: two scratch profiles on the dev build, the built companion installed into
// each scratch user data dir (never the real one). A setting, a custom search engine, and an address seeded in A
// reach B's profile files only after B quits, and Helium keeps them on relaunch. Usage: node profile-mode.mjs
// Needs companion/dist/helium-sync-companion (npm run build in companion/).
import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { connect, launch, sleep, until } from './cdp.mjs';
import { putAddress, putEngine } from '../../companion/src/webdata.ts';

const EXT = '/Users/conan/Dev/open-synclium/extension/dist-dev';
const COMPANION = '/Users/conan/Dev/open-synclium/companion/dist/helium-sync-companion';
const SCRATCH = '/tmp/helium-sync-scratch/e2e-profile';
const checks = [];
const check = (ok, what, detail = '') => {
  checks.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`);
};

const ENGINE_ID = '7e1f0c3a-7a52-4c1e-9f0a-10c0aa0000e1';
const ADDRESS_ID = '7e1f0c3a-7a52-4c1e-9f0a-10c0aa0000a1';
const engine = { kind: 'engine', name: 'E2E Engine', keyword: 'e2e', url: 'https://e2e.example.test/search?q={searchTerms}', suggestUrl: '', faviconUrl: '', newTabUrl: '', imageUrl: '', alternateUrls: [], active: true };
const TOKEN_TYPES = [3, 4, 5, 7, 9, 14, 32, 33, 34, 35, 36, 60, 77, 79, 81, 103, 104, 105, 107, 108, 109, 110, 116, 135, 136, 140, 141, 142, 143, 144, 151, 152, 153, 156, 157, 163, 164, 165];
const filled = { 3: ['Sam', 1], 5: ['Example', 1], 7: ['Sam Example', 4], 9: ['sam@example.test', 0], 33: ['Lisbon', 4], 36: ['PT', 4], 77: ['1 Example St', 4], 109: ['Example', 1] };
const address = { kind: 'address', languageCode: '', label: '', tokens: TOKEN_TYPES.map((type) => [type, filled[type]?.[0] ?? '', filled[type]?.[1] ?? 0]) };

/** Chromium's id for an unpacked extension: sha256 of its path, first 16 bytes, hex digits 0-f spelled a-p. */
const unpackedId = (path) => createHash('sha256').update(path).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
const EXT_ID = unpackedId(EXT);

const paths = (name) => ({ data: `${SCRATCH}/profile-${name}`, home: `${SCRATCH}/home-${name}`, port: name === 'a' ? 9381 : 9382 });
const prefsOf = (name) => JSON.parse(readFileSync(`${paths(name).data}/Default/Preferences`, 'utf8'));

async function stopScratch() {
  execSync(`pkill -f '${SCRATCH}/profile' || true`);
  for (let i = 0; i < 40 && execSync(`pgrep -f '${SCRATCH}/profile' || true`).toString().trim() !== ''; i++) await sleep(250);
  await sleep(500);
}

/** Launch one scratch device. The companion Helium spawns inherits HELIUM_SYNC_COMPANION_HOME, so its state stays in scratch. */
async function open(name) {
  const { data, home, port } = paths(name);
  process.env.HELIUM_SYNC_COMPANION_HOME = home;
  launch({ profile: data, port, ext: EXT });
  const browser = await connect(port);
  const isWorker = (t) => t.type === 'service_worker' && t.url.endsWith('/worker-dev.js');
  const sw = await browser.waitTarget(isWorker, 5000).catch(async () => {
    await browser.openPage(`chrome-extension://${EXT_ID}/popup.html`, `${name}-wake`);
    return browser.waitTarget(isWorker);
  });
  const worker = await browser.attach(sw.targetId, `${name}-worker`);
  const app = await browser.openPage(`chrome-extension://${EXT_ID}/app.html#status`, `${name}-app`);
  const ask = (message) => app.eval(`chrome.runtime.sendMessage(${JSON.stringify(message)})`);
  const shown = () => worker.eval(`chrome.storage.local.get('shown').then((r) => r.shown ?? null)`);
  const settle = async () => {
    const before = (await shown())?.report?.at ?? 0;
    await ask({ kind: 'sync-now' });
    return until(async () => {
      const s = await shown();
      return s?.report?.at > before ? s : null;
    }, `${name} next report`);
  };
  /** Quit through CDP, then wait until the process is gone. */
  const quit = async () => {
    await browser.call('Browser.close').catch(() => {});
    browser.close();
    for (let i = 0; i < 60 && execSync(`pgrep -f '${data}' || true`).toString().trim() !== ''; i++) await sleep(500);
  };
  return { browser, worker, app, ask, shown, settle, quit, errors: () => [...worker.errors, ...app.errors] };
}

/** The dev store's files for one device, carried to another profile as a sync client would. */
async function carry(from, to, device) {
  const files = await from.worker.eval(`chrome.storage.local.get(null).then((all) => Object.fromEntries(Object.entries(all).filter(([k]) => k.startsWith('store:devices/${device}/'))))`);
  await to.worker.eval(`chrome.storage.local.set(${JSON.stringify(files)}).then(() => true)`);
  return Object.keys(files).length;
}

/** Setup through the page's protocol: preview with the key, then Start. */
async function setup(device, name, key) {
  const preview = await device.ask({ kind: 'preview', key });
  const start = await device.ask({ kind: 'start', name, historyOn: false, key });
  return { preview: preview.value, start: start.value };
}

function webDataRows(name) {
  const db = new DatabaseSync(`file:${paths(name).data}/Default/Web Data?immutable=1`, { readOnly: true });
  try {
    const engines = db.prepare(`select sync_guid, keyword from keywords where keyword = 'e2e'`).all();
    const addresses = db.prepare(`select t.value from address_type_tokens t where t.type = 9 and t.value = 'sam@example.test'`).all();
    return { engines: engines.length, addresses: addresses.length };
  } finally {
    db.close();
  }
}

try {
  if (!existsSync(COMPANION)) throw new Error(`build the companion first: ${COMPANION}`);
  await stopScratch();
  rmSync(SCRATCH, { recursive: true, force: true });
  // A first launch creates each profile (the installer refuses a dir without Local State). Then the companion is
  // installed into each scratch user data dir, and, with A closed, A gets what a user would have: one setting,
  // one custom engine, one address.
  for (const name of ['a', 'b']) {
    await (await open(name)).quit();
    const { data, home } = paths(name);
    execFileSync(COMPANION, ['install', '--extension-id', EXT_ID, '--user-data-dir', data], { env: { ...process.env, HELIUM_SYNC_COMPANION_HOME: home } });
  }
  const aPrefs = prefsOf('a');
  aPrefs.download = { ...aPrefs.download, prompt_for_download: true };
  writeFileSync(`${paths('a').data}/Default/Preferences`, JSON.stringify(aPrefs));
  const seed = new DatabaseSync(`${paths('a').data}/Default/Web Data`);
  putEngine(seed, ENGINE_ID, engine, new Set());
  putAddress(seed, ADDRESS_ID, address);
  seed.close();

  const a = await open('a');
  const key = await a.app.eval(`import(chrome.runtime.getURL('sync-key.js')).then((m) => m.mintSyncKey())`);
  const aSetup = await setup(a, 'Device A', key);
  check(aSetup.start?.kind === 'started', 'A starts', JSON.stringify(aSetup));
  const status = await a.ask({ kind: 'profile-status' });
  check(status.value?.hello?.profiles?.some((p) => p.dir === 'Default'), 'A\'s companion answers hello with the scratch profile', JSON.stringify(status.value?.hello));
  await a.ask({ kind: 'set-profile-mode', dir: 'Default' });
  const aReport = await until(async () => {
    const s = await a.settle();
    const r = s.report;
    return r?.kind === 'cycle' && r.settings.kind === 'synced' && r.searchEngines.kind === 'synced' && r.addresses.kind === 'synced' ? s : null;
  }, 'A publishes its profile types', 60000);
  check(aReport.profile?.kind === 'on', 'A\'s profile mode is on', JSON.stringify(aReport.profile));
  const aId = aReport.report.device;

  const b = await open('b');
  console.log('A carries', await carry(a, b, aId), 'files to B');
  const bSetup = await setup(b, 'Device B', key);
  check(bSetup.start?.kind === 'started', 'B joins with the key', JSON.stringify(bSetup.preview));
  await b.ask({ kind: 'set-profile-mode', dir: 'Default' });
  const bReport = await until(async () => {
    const s = await b.settle();
    return s.profile?.kind === 'on' && s.profile.pending >= 3 ? s : null;
  }, 'B stages A\'s setting, engine, and address', 60000);
  check(true, 'B staged changes for the companion', JSON.stringify(bReport.profile));
  check(prefsOf('b').download?.prompt_for_download !== true, 'B\'s Preferences are untouched while B runs');
  check(webDataRows('b').engines === 0 && webDataRows('b').addresses === 0, 'B\'s Web Data is untouched while B runs', JSON.stringify(webDataRows('b')));
  const errors = [...a.errors(), ...b.errors()];
  await a.quit();
  await b.quit();

  const written = await until(() => (prefsOf('b').download?.prompt_for_download === true ? true : null), 'the helper writes B\'s profile after quit', 30000).catch(() => false);
  check(written === true, 'after B quits, the helper writes the setting');
  check(webDataRows('b').engines === 1 && webDataRows('b').addresses === 1, 'after B quits, the engine and the address are in B\'s Web Data', JSON.stringify(webDataRows('b')));

  const again = await open('b');
  const settings = await again.browser.openPage('chrome://settings/', 'b-settings');
  await sleep(1500);
  const pref = await settings.eval(`chrome.settingsPrivate.getPref('download.prompt_for_download').then((p) => p.value)`);
  check(pref === true, 'relaunched B shows the synced setting in chrome://settings', String(pref));
  const reset = prefsOf('b').prefs?.tracked_preferences_reset;
  check(reset === undefined, 'Helium reset nothing on relaunch', JSON.stringify(reset));
  const settled = await again.settle();
  check(settled.profile?.kind === 'on' && settled.profile.pending === 0, 'nothing is left pending after the relaunch', JSON.stringify(settled.profile));
  check(settled.failure === null, 'no cycle failure on B');
  check(errors.length === 0, 'no console errors', errors.join(' | '));
  await again.quit();
  check(webDataRows('b').engines === 1 && webDataRows('b').addresses === 1, 'Helium kept the engine and the address through a run', JSON.stringify(webDataRows('b')));
} catch (error) {
  check(false, 'profile-mode run', error.stack);
} finally {
  await stopScratch();
}
console.log(`\n${checks.filter(Boolean).length}/${checks.length} checks passed`);
process.exit(checks.every(Boolean) ? 0 : 1);
