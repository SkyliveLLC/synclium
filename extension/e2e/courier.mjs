// Two scratch profiles on the dev build. Each profile's dev store is its own chrome.storage.local, so this
// script plays the sync folder: it copies one device's `store:devices/<id>/...` keys into the other profile.
import { createServer } from 'node:http';
import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { connect, launch, sleep, until } from './cdp.mjs';

const EXT = '/Users/conan/Dev/open-synclium/extension/dist-dev';
const SCRATCH = '/tmp/helium-sync-scratch/u2';
const SHOTS = `${SCRATCH}/shots`;

const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(`<!doctype html><title>Page ${req.url} on A</title><p>${req.url}</p>`);
}).listen(8766, '127.0.0.1');

const checks = [];
const check = (ok, what, detail = '') => {
  checks.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`);
};

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
  const sw = await browser.waitTarget((t) => t.type === 'service_worker' && t.url.endsWith('/worker-dev.js'));
  const worker = await browser.attach(sw.targetId, `${name}-worker`);
  const extId = new URL(sw.url).host;
  const page = (hash) => browser.openPage(`chrome-extension://${extId}/app.html${hash}`, `${name}-app`);
  const shown = () => worker.eval(`chrome.storage.local.get('shown').then((r) => r.shown ?? null)`);
  const ask = (message) => setupPage.eval(`chrome.runtime.sendMessage(${JSON.stringify(message)})`);
  let setupPage = null;
  return {
    browser, worker, extId, page, shown,
    async start(deviceName) {
      setupPage = await page('#setup');
      await until(() => setupPage.eval(`!document.getElementById('start').disabled`), `${name} Start enabled`);
      const preview = await setupPage.eval(`document.getElementById('preview').textContent`);
      await setupPage.shot(`${SHOTS}/two-${name}-setup.png`);
      await setupPage.eval(`document.getElementById('name').value = ${JSON.stringify(deviceName)}; document.getElementById('start').click(); true`);
      const first = await until(async () => ((await shown())?.report?.kind === 'cycle' ? shown() : null), `${name} first cycle`);
      return { preview, first };
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
  const aId = aStart.first.report.device;
  await a.worker.eval(`chrome.bookmarks.create({ parentId: '1', title: 'Shared folder' }).then((f) => chrome.bookmarks.create({ parentId: f.id, title: 'Inside A', url: 'https://example.com/inside-a' })).then(() => true)`);
  const visit = await a.browser.openPage('http://127.0.0.1:8766/alpha', 'a-visit');
  await a.browser.call('Page.navigate', { url: 'http://127.0.0.1:8766/beta' }, visit.sessionId);
  await sleep(2000);
  await until(async () => {
    const s = await a.syncAndSettle();
    const files = Object.keys(await a.storeKeys(`store:devices/${aId}/history/`));
    return s.report.bookmarks.kind === 'synced' && files.length > 0 ? files : null;
  }, 'A published bookmarks and a history shard', 120000);
  console.log('A carries:', (await carry(a, b, aId)).join(', '));

  const bStart = await b.start('Device B');
  check(bStart.preview.startsWith('Joining Device A.'), 'B previews joining A before writing anything', bStart.preview);
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
