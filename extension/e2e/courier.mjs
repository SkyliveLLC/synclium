// Two scratch profiles on the dev build. Each profile's dev store is its own chrome.storage.local, so this
// script plays the sync folder: it copies one device's `store:devices/<id>/...` keys into the other profile.
import { createServer } from 'node:http';
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { connect, launch, sleep, until } from './cdp.mjs';

const EXT = '/Users/conan/Dev/open-synclium/extension/dist-dev';
const SCRATCH = '/tmp/helium-sync-scratch/u2';
const SHOTS = `${SCRATCH}/shots`;
mkdirSync(SHOTS, { recursive: true });

const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(`<!doctype html><title>Page ${req.url} on A</title><p>${req.url}</p>`);
}).listen(8766, '127.0.0.1');

const checks = [];
const check = (ok, what, detail = '') => {
  checks.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`);
};

/** Chromium's id for an unpacked extension: sha256 of its path, first 16 bytes, hex digits 0-f spelled a-p. */
function unpackedId(path) {
  return createHash('sha256').update(path).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
}

async function stopScratch() {
  execSync(`pkill -f 'u2/profile' || true`);
  for (let i = 0; i < 40 && execSync(`pgrep -f 'u2/profile' || true`).toString().trim() !== ''; i++) await sleep(250);
  await sleep(500);
}

async function device(name, port) {
  const profile = `${SCRATCH}/profile-${name}`;
  rmSync(profile, { recursive: true, force: true });
  launch({ profile, port, ext: EXT });
  const browser = await connect(port);
  const isWorker = (t) => t.type === 'service_worker' && t.url.endsWith('/worker-dev.js');
  // The worker can go idle before we attach. Opening one of its pages wakes it.
  const sw = await browser.waitTarget(isWorker, 5000).catch(async () => {
    await browser.openPage(`chrome-extension://${unpackedId(EXT)}/popup.html`, `${name}-wake-popup`);
    return browser.waitTarget(isWorker);
  });
  const worker = await browser.attach(sw.targetId, `${name}-worker`);
  const extId = new URL(sw.url).host;
  const page = (hash) => browser.openPage(`chrome-extension://${extId}/app.html${hash}`, `${name}-app`);
  const shown = () => worker.eval(`chrome.storage.local.get('shown').then((r) => r.shown ?? null)`);
  const ask = (message) => setupPage.eval(`chrome.runtime.sendMessage(${JSON.stringify(message)})`);
  let setupPage = null;
  return {
    browser, worker, extId, page, shown,
    /** Setup through the page. With `key`, it is typed into the key field (a joining device). */
    async start(deviceName, key = null) {
      setupPage = await page('#setup');
      const typeKey = (text) => setupPage.eval(`(() => { const input = document.getElementById('key-input'); input.value = ${JSON.stringify(text)}; input.dispatchEvent(new Event('input')); return true; })()`);
      const note = () => setupPage.eval(`document.getElementById('key-note').textContent`);
      if (key !== null) {
        await until(() => setupPage.eval(`!document.getElementById('key-enter').hidden`), `${name} asks for the key`);
        // A well-formed key that is not the folder's: flip one digit.
        const wrong = key.replace(/^(HSK-.)./, (m, head) => head + (m.endsWith('2') ? '3' : '2'));
        await typeKey(wrong);
        const refused = await until(async () => ((await note()).includes("doesn't match") ? note() : null), `${name} refuses a wrong key`);
        check(await setupPage.eval(`document.getElementById('start').disabled`), `${name} keeps Start disabled under a wrong key`, refused);
        await typeKey(key.toLowerCase().replace(/-/g, ' '));
      }
      await until(() => setupPage.eval(`!document.getElementById('start').disabled`), `${name} Start enabled`);
      const preview = await setupPage.eval(`document.getElementById('preview').textContent`);
      const shownKey = await setupPage.eval(`document.getElementById('key-new').hidden ? null : document.getElementById('key-shown').textContent`);
      await setupPage.shot(`${SHOTS}/two-${name}-setup.png`);
      await setupPage.eval(`document.getElementById('name').value = ${JSON.stringify(deviceName)}; document.getElementById('start').click(); true`);
      const first = await until(async () => ((await shown())?.report?.kind === 'cycle' ? shown() : null), `${name} first cycle`);
      return { preview, first, key: shownKey, note: await note() };
    },
    ask,
    get errors() { return [...worker.errors, ...(setupPage?.errors ?? [])]; },
    async storeKeys(prefix) {
      return worker.eval(`chrome.storage.local.get(null).then((all) => Object.fromEntries(Object.entries(all).filter(([k]) => k.startsWith(${JSON.stringify(prefix)}))))`);
    },
    async putKeys(entries) {
      return worker.eval(`chrome.storage.local.set(${JSON.stringify(entries)}).then(() => true)`);
    },
    async syncAndSettle() {
      const before = (await shown())?.report?.at ?? 0;
      await ask({ kind: 'sync-now' });
      return until(async () => {
        const s = await shown();
        return s?.report?.at > before ? s : null;
      }, `${name} next report`);
    },
  };
}

/** The courier: one device's files, as a folder sync client would deliver them. */
async function carry(from, to, deviceId) {
  const files = await from.storeKeys(`store:devices/${deviceId}/`);
  await to.putKeys(files);
  return Object.keys(files).map((k) => k.slice(`store:devices/${deviceId}/`.length));
}

try {
  await stopScratch();
  const a = await device('a', 9338);
  const b = await device('b', 9339);

  const aStart = await a.start('Device A');
  check(aStart.preview.startsWith('New sync folder'), 'A previews a new sync folder', aStart.preview);
  check(/^HSK(-[0-9A-Z]{4}){13}$/.test(aStart.key ?? ''), 'A shows the sync key it minted', aStart.key);
  const aId = aStart.first.report.device;
  await a.worker.eval(`chrome.bookmarks.create({ parentId: '1', title: 'Shared folder' }).then((f) => chrome.bookmarks.create({ parentId: f.id, title: 'Inside A', url: 'https://example.com/inside-a' })).then(() => true)`);
  await a.worker.eval(`chrome.readingList.addEntry({ url: 'https://example.com/read-later', title: 'Read later on A', hasBeenRead: false }).then(() => true)`);
  const visit = await a.browser.openPage('http://127.0.0.1:8766/alpha', 'a-visit');
  await a.browser.call('Page.navigate', { url: 'http://127.0.0.1:8766/beta' }, visit.sessionId);
  await sleep(2000);
  await until(async () => {
    const s = await a.syncAndSettle();
    const files = Object.keys(await a.storeKeys(`store:devices/${aId}/history/`));
    return s.report.bookmarks.kind === 'synced' && files.length > 0 ? files : null;
  }, 'A published bookmarks and a history shard', 120000);
  await until(async () => ((await a.syncAndSettle()).report.readingList.kind === 'synced' ? true : null), 'A publishes its reading list');
  const aFiles = await a.storeKeys(`store:devices/${aId}/`);
  check(!JSON.stringify(aFiles).includes('Inside A') && Object.values(aFiles).every((f) => !atob(f.b64).includes('Inside A') && !atob(f.b64).includes('Device A')),
    'A\'s files, manifest included, hold no readable bookmark title or device name');
  console.log('A carries:', (await carry(a, b, aId)).join(', '));

  const bStart = await b.start('Device B', aStart.key);
  check(bStart.preview.startsWith('Joining Device A.'), 'B previews joining A once the key matches', `${bStart.note} ${bStart.preview}`);
  const bId = bStart.first.report.device;
  const applied = await until(async () => {
    const found = await b.worker.eval(`chrome.bookmarks.search({ title: 'Inside A' }).then(async ([n]) => n ? { url: n.url, parent: (await chrome.bookmarks.get(n.parentId))[0].title } : null)`);
    return found ?? (await b.syncAndSettle(), null);
  }, 'B applies A\'s bookmarks through chrome.bookmarks', 120000);
  check(applied.parent === 'Shared folder' && applied.url === 'https://example.com/inside-a', 'A\'s folder and bookmark appear in B\'s profile', JSON.stringify(applied));
  const visits = await until(async () => {
    const reply = await b.ask({ kind: 'search-history', query: '8766' });
    return reply.ok && reply.value.length >= 2 ? reply.value : null;
  }, 'B indexes A\'s visits', 60000);
  check(visits.every((v) => v.deviceName === 'Device A'), 'B\'s history search finds A\'s visits', visits.map((v) => `${v.title} (${v.deviceName})`).join(', '));
  const bHistory = await b.browser.openPage(`chrome-extension://${b.extId}/app.html?q=8766#history`, 'b-history');
  await sleep(1000);
  console.log('B history tab:', (await bHistory.eval(`document.querySelector('#history').innerText`)).replace(/\n/g, ' / '));
  await bHistory.shot(`${SHOTS}/two-b-history.png`);
  const bOwnHistory = await b.worker.eval(`chrome.history.search({ text: '', startTime: 0, maxResults: 0 }).then((r) => r.map((i) => i.url))`);
  check(!bOwnHistory.some((url) => url.startsWith('http://127.0.0.1:8766/')), 'A\'s visits never enter B\'s own Helium history', `B's chrome.history: ${bOwnHistory.join(', ')}`);

  const reading = await until(
    async () => (await b.worker.eval(`chrome.readingList.query({ url: 'https://example.com/read-later' })`))[0] ?? (await b.syncAndSettle(), null),
    'B applies A\'s reading list',
    60000,
  );
  check(reading.title === 'Read later on A' && !reading.hasBeenRead, 'A\'s reading list entry appears in B\'s Helium', JSON.stringify(reading));
  await b.worker.eval(`chrome.readingList.updateEntry({ url: 'https://example.com/read-later', hasBeenRead: true }).then(() => true)`);
  await b.worker.eval(`chrome.bookmarks.create({ parentId: '2', title: 'From B', url: 'https://example.com/from-b' }).then(() => chrome.bookmarks.search({ title: 'Inside A' })).then(([n]) => chrome.bookmarks.update(n.id, { title: 'Renamed on B' })).then(() => true)`);
  await until(async () => {
    const s = await b.syncAndSettle();
    return s.report.bookmarks.kind === 'synced' && s.report.bookmarks.stamped > 0 ? s : null;
  }, 'B publishes its edits', 60000);
  console.log('B carries:', (await carry(b, a, bId)).join(', '));
  const back = await until(async () => {
    await a.syncAndSettle();
    return a.worker.eval(`Promise.all([chrome.bookmarks.search({ title: 'From B' }), chrome.bookmarks.search({ title: 'Renamed on B' }), chrome.bookmarks.search({ title: 'Inside A' })]).then(([x, y, z]) => ({ fromB: x.length, renamed: y.length, oldTitle: z.length }))`).then((r) => (r.fromB === 1 && r.renamed === 1 ? r : null));
  }, 'A applies B\'s edits', 120000);
  check(back.oldTitle === 0, 'B\'s new bookmark and rename reach A, with no duplicate', JSON.stringify(back));
  const readOnA = await until(async () => {
    const [entry] = await a.worker.eval(`chrome.readingList.query({ url: 'https://example.com/read-later' })`);
    return entry?.hasBeenRead ? entry : (await a.syncAndSettle(), null);
  }, 'A applies B\'s read mark', 60000);
  check((await a.worker.eval(`chrome.readingList.query({})`)).length === 1, 'B\'s read mark reaches A, still one entry', JSON.stringify(readOnA));
  const aReport = (await a.shown()).report;
  check(aReport.peers.some((p) => p.name === 'Device B'), 'A\'s report lists Device B as a peer', JSON.stringify(aReport.peers));
  const aStatus = await a.page('#status');
  console.log('A status tab:', (await aStatus.eval(`document.querySelector('#status').innerText`)).replace(/\n/g, ' / '));
  await aStatus.shot(`${SHOTS}/two-a-status.png`);
  const errors = [...a.errors, ...b.errors, ...bHistory.errors, ...aStatus.errors];
  check(errors.length === 0, 'no console errors in either profile', errors.join(' | '));
  check((await a.shown()).failure === null && (await b.shown()).failure === null, 'no cycle failures recorded');
  a.browser.close();
  b.browser.close();
} catch (error) {
  check(false, 'courier run', error.stack);
} finally {
  await stopScratch();
  server.close();
}
console.log(`\n${checks.filter(Boolean).length}/${checks.length} checks passed`);
process.exit(checks.every(Boolean) ? 0 : 1);
