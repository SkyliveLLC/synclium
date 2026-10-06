// Unit 3 on the real surface: the release build in scratch Helium (already launched on 9339), with OPFS standing in
// for a picked folder. Launch HeliumScratch.app with --remote-debugging-port=9339 --load-extension=<dist> first.
import { connect, sleep, until } from './cdp.mjs';

const SHOTS = '/tmp/helium-sync-scratch/u3/shots';
const checks = [];
const check = (ok, what, detail = '') => {
  checks.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`);
};

const browser = await connect(9339);
const sw = await browser.waitTarget((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'));
const extId = new URL(sw.url).host;
const worker = await browser.attach(sw.targetId, 'worker');
check(sw.url.endsWith('/worker.js'), 'release build runs worker.js', sw.url);
const url = (path) => `chrome-extension://${extId}/${path}`;
const SHOWN = `chrome.storage.local.get('shown').then((r) => r.shown ?? null)`;

const setup = await browser.openPage(url('app.html#setup'), 'app-setup');
check(await setup.eval(`!document.getElementById('choose').disabled && document.getElementById('start').disabled`), 'setup offers Choose folder, Start waits for a folder');
console.log('setup preview:', await setup.eval(`document.getElementById('preview').textContent`));
await setup.shot(`${SHOTS}/1-setup-not-set-up.png`);
const popup0 = await browser.openPage(url('popup.html'), 'popup-not-set-up');
console.log('popup:', JSON.stringify(await popup0.eval(`document.body.innerText`)));
await popup0.shot(`${SHOTS}/2-popup-not-set-up.png`);

// The Store against a real FileSystemDirectoryHandle (OPFS), in the page.
const storeRun = await setup.eval(`(async () => {
  const fs = await import('/folder-store.js');
  const opfs = await navigator.storage.getDirectory();
  for await (const name of opfs.keys()) await opfs.removeEntry(name, { recursive: true });
  const root = await fs.storeRootIn(opfs);
  const again = await fs.storeRootIn(opfs);
  const conn = await fs.connectRoot(root);
  const store = conn.store;
  const enc = (s) => new TextEncoder().encode(s);
  const dec = (b) => new TextDecoder().decode(b);
  const key = 'devices/00000000-0000-4000-8000-000000000001/history/2026-10-06.hsync';
  const out = { root: root.name, sameRoot: await root.isSameEntry(again), access: conn.access, perm: await root.queryPermission({ mode: 'readwrite' }) };
  out.probe = await store.probe();
  await store.put(key, enc('one'));
  const g1 = await store.get(key, null);
  out.get1 = { kind: g1.kind, text: dec(g1.bytes), version: g1.version };
  out.unchanged = (await store.get(key, g1.version)).kind;
  await new Promise((r) => setTimeout(r, 1100));
  await store.put(key, enc('two'));
  const g2 = await store.get(key, g1.version);
  out.get2 = { kind: g2.kind, text: g2.kind === 'ok' ? dec(g2.bytes) : null, version: g2.version };
  out.listDevices = await store.list('devices/');
  out.listHistory = await store.list('devices/00000000-0000-4000-8000-000000000001/history/');
  out.missing = (await store.get('devices/00000000-0000-4000-8000-000000000001/manifest.json', null)).kind;
  await store.delete(key);
  await store.delete(key);
  out.afterDelete = await store.list('devices/');
  out.rootEntries = []; for await (const n of root.keys()) out.rootEntries.push(n);
  // A moved folder: hold the handle, remove the folder, and see what the store says.
  const doomed = await opfs.getDirectoryHandle('Doomed', { create: true });
  await doomed.getDirectoryHandle('devices', { create: true });
  const doomedStore = fs.folderStore(doomed);
  await opfs.removeEntry('Doomed', { recursive: true });
  out.goneConnect = await fs.connectRoot(doomed);
  try { await doomedStore.list('devices/'); out.goneList = 'resolved'; } catch (e) { out.goneList = e.why ?? String(e); }
  try { out.goneGet = await doomedStore.get(key, null); } catch (e) { out.goneGet = e.why ?? String(e); }
  out.goneProbe = await doomedStore.probe();
  return out;
})()`);
console.log('store run:', JSON.stringify(storeRun, null, 1));
check(storeRun.root === 'Helium Sync' && storeRun.sameRoot && storeRun.access === 'ready' && storeRun.perm === 'granted', 'storeRootIn creates Helium Sync/ once and connectRoot is ready');
check(storeRun.probe.kind === 'ok', 'probe ok on a real handle');
check(storeRun.get1.kind === 'ok' && storeRun.get1.text === 'one' && storeRun.unchanged === 'unchanged', 'put then get, then unchanged with the known version', storeRun.get1.version);
check(storeRun.get2.kind === 'ok' && storeRun.get2.text === 'two' && storeRun.get2.version !== storeRun.get1.version, 'a same-size rewrite reads as changed', `${storeRun.get1.version} -> ${storeRun.get2.version}`);
check(JSON.stringify(storeRun.listDevices) === '["00000000-0000-4000-8000-000000000001"]' && JSON.stringify(storeRun.listHistory) === '["2026-10-06.hsync"]', 'list is one level, no .crswap after close');
check(storeRun.missing === 'missing' && JSON.stringify(storeRun.afterDelete) === '[]' && JSON.stringify(storeRun.rootEntries) === '["devices"]', 'missing key, idempotent delete pruning empty folders, devices/ kept, no probe left');
check(storeRun.goneConnect.access === 'failed' && storeRun.goneConnect.why.kind === 'missing' && storeRun.goneList.kind === 'missing' && storeRun.goneGet.kind === 'missing' && storeRun.goneProbe.why?.kind === 'missing', 'a removed folder is missing, not empty', JSON.stringify([storeRun.goneConnect, storeRun.goneList, storeRun.goneGet, storeRun.goneProbe]));

// A .crswap is visible while a writable is open (what a killed worker leaves behind).
const swap = await setup.eval(`(async () => {
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('Helium Sync');
  const f = await root.getFileHandle('swap-test.hsync', { create: true });
  const w = await f.createWritable();
  await w.write(new Uint8Array([1, 2, 3]));
  const during = []; for await (const n of root.keys()) during.push(n);
  await w.close();
  const after = []; for await (const n of root.keys()) after.push(n);
  await root.removeEntry('swap-test.hsync');
  return { during, after };
})()`);
console.log('swap file (OPFS):', JSON.stringify(swap));

// The release worker syncs into the OPFS store: the page saves it as the candidate, Start promotes it.
await setup.eval(`(async () => {
  const { handles } = await import('/local.js');
  await handles.putCandidate(await (await navigator.storage.getDirectory()).getDirectoryHandle('Helium Sync'));
  return true;
})()`);
await setup.eval(`location.reload(); true`);
await sleep(1500);
await until(() => setup.eval(`!document.getElementById('start').disabled`), 'Start enabled for the candidate');
console.log('preview:', await setup.eval(`document.getElementById('preview').textContent`), '|', await setup.eval(`document.getElementById('store-label').textContent`));
await setup.shot(`${SHOTS}/3-setup-candidate.png`);
await worker.eval(`chrome.bookmarks.create({ parentId: '1', title: 'U3 bookmark', url: 'https://example.com/u3' }).then(() => true)`);
await setup.eval(`document.getElementById('name').value = 'Scratch U3'; document.getElementById('start').click(); true`);
const first = await until(async () => {
  const s = await worker.eval(SHOWN);
  return s?.report?.kind === 'cycle' && s.report.store.access === 'ready' ? s : null;
}, 'first cycle on the folder store', 90000);
const device = first.report.device;
const files = await setup.eval(`(async () => {
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('Helium Sync');
  const dir = await (await root.getDirectoryHandle('devices')).getDirectoryHandle(${JSON.stringify(device)});
  const names = []; for await (const n of dir.keys()) names.push(n);
  const manifest = JSON.parse(await (await (await dir.getFileHandle('manifest.json')).getFile()).text());
  const bm = await (await dir.getFileHandle('bookmarks.hsync')).getFile();
  const nl = new Uint8Array(await bm.arrayBuffer()).indexOf(10);
  const body = await new Response(bm.slice(nl + 1).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  return { names: names.sort(), manifestFiles: Object.keys(manifest.files), hasBookmark: body.includes('U3 bookmark') };
})()`);
check(files.names.includes('manifest.json') && files.names.includes('bookmarks.hsync') && files.hasBookmark, 'the release worker published into the real directory handle', JSON.stringify(files));
console.log('setup result:', await setup.eval(`document.getElementById('setup-result').textContent`));
const badgeOk = await setup.eval(`chrome.action.getBadgeText({})`);
check(badgeOk === '', 'badge blank when synced', JSON.stringify(badgeOk));
const popupOk = await browser.openPage(url('popup.html'), 'popup-ok');
console.log('popup:', JSON.stringify(await popupOk.eval(`document.body.innerText`)));
await popupOk.shot(`${SHOTS}/4-popup-ok.png`);

// Missing, for real: the worker's next cycle finds the folder gone.
await setup.eval(`(async () => { await (await navigator.storage.getDirectory()).removeEntry('Helium Sync', { recursive: true }); await chrome.runtime.sendMessage({ kind: 'sync-now' }); return true; })()`);
const missing = await until(async () => {
  const s = await worker.eval(SHOWN);
  return s?.report?.kind === 'cycle' && s.report.store.access === 'failed' ? s.report.store : null;
}, 'missing report', 60000);
check(missing.why.kind === 'missing', 'worker reports a removed folder as missing', JSON.stringify(missing));
const badgeMissing = await setup.eval(`chrome.action.getBadgeText({})`);
check(badgeMissing === '!', 'badge ! when the folder is missing');
const popupMissing = await browser.openPage(url('popup.html'), 'popup-missing');
const missingText = await popupMissing.eval(`document.body.innerText`);
check(missingText.includes("Can't find Helium Sync") && missingText.includes('Choose folder'), 'popup: missing state offers Choose folder', JSON.stringify(missingText));
await popupMissing.shot(`${SHOTS}/5-popup-missing.png`);

// Needs-permission: OPFS is always granted, so the report is stubbed in storage the way the worker writes it.
await setup.eval(`(async () => {
  const ui = await import('/ui.js');
  const s = await ui.readShown();
  await chrome.storage.local.set(ui.storedShown({ ...s, report: { ...s.report, at: Date.now(), store: { access: 'failed', label: 'Helium Sync', why: { kind: 'needs-permission' } } } }));
  return true;
})()`);
const popupPerm = await browser.openPage(url('popup.html'), 'popup-needs-permission');
const permText = await popupPerm.eval(`document.body.innerText`);
check(permText.includes('Paused until you allow access to Helium Sync') && permText.includes('Allow access'), 'popup: needs-permission offers Allow access', JSON.stringify(permText));
await popupPerm.shot(`${SHOTS}/6-popup-needs-permission.png`);
const before = new Set((await browser.targets()).map((t) => t.targetId));
await popupPerm.eval(`document.getElementById('action').click(); true`);
const allowTarget = await browser.waitTarget((t) => !before.has(t.targetId) && t.url.endsWith('app.html#allow'));
check(true, '[Allow access] opens app.html#allow', allowTarget.url);
const allow = await browser.attach(allowTarget.targetId, 'app-allow');
await browser.call('Page.enable', {}, allow.sessionId);
await browser.call('Emulation.setDeviceMetricsOverride', { width: 900, height: 600, deviceScaleFactor: 1, mobile: false }, allow.sessionId);
await sleep(800);
console.log('allow page:', JSON.stringify(await allow.eval(`document.getElementById('allow').innerText`)));
await allow.shot(`${SHOTS}/7-allow.png`);

// Allow against a real handle: put OPFS back as current, click Allow access.
await allow.eval(`(async () => {
  const { handles } = await import('/local.js');
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('Helium Sync', { create: true });
  await root.getDirectoryHandle('devices', { create: true });
  await handles.putCandidate(root);
  await handles.promote();
  return true;
})()`);
await allow.eval(`document.getElementById('allow-button').click(); true`);
await until(() => allow.eval(`location.hash === '#status'`), 'allow moves to status');
const recovered = await until(async () => {
  const s = await worker.eval(SHOWN);
  return s?.report?.kind === 'cycle' && s.report.store.access === 'ready' ? s : null;
}, 'ready again after allow', 60000);
check(recovered !== null && (await setup.eval(`chrome.action.getBadgeText({})`)) === '', 'Allow access re-syncs and clears the badge');
await sleep(500);
console.log('status:', JSON.stringify(await allow.eval(`document.getElementById('status-line').textContent`)));
await allow.shot(`${SHOTS}/8-status-after-allow.png`);

const adv = await browser.openPage(url('app.html#advanced'), 'app-advanced');
check(await adv.eval(`!document.getElementById('change-folder').disabled`), 'Advanced offers Change folder');
await adv.shot(`${SHOTS}/9-advanced.png`);

await sleep(1000);
const errors = [...worker.errors, ...setup.errors, ...popup0.errors, ...popupOk.errors, ...popupMissing.errors, ...popupPerm.errors, ...allow.errors, ...adv.errors];
check(errors.length === 0, 'no console errors in worker or pages', errors.join(' | '));
console.log(`${checks.filter(Boolean).length}/${checks.length} passed`);
browser.close();
process.exit(checks.every(Boolean) ? 0 : 1);
