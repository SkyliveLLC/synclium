// WebDAV on the real surface: two scratch Helium profiles set up sync through app.html against a local server.
// Setup, all under /tmp/hs-dav:
//   server     wsgidav on 127.0.0.1:8765 serving ./root, user `me`, password `s3cret pässword`, Basic auth only,
//              with root/files/me/ created first (python3 -m venv venv && venv/bin/pip install wsgidav cheroot)
//   browsers   HeliumDav.app and HeliumDavB.app: copies of HeliumScratch.app, each with its own
//              CFBundleIdentifier and an ad-hoc signature. Helium hands a launch to a running instance of the
//              same bundle, whatever --user-data-dir says, so each device needs its own bundle.
//   ext        dist/ plus `"host_permissions": ["http://127.0.0.1/*"]` in its manifest. CDP cannot click
//              Chromium's permission bubble, so the grant is preinstalled and permissions.request answers at once.
// Run: node e2e/webdav.mjs
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect, until } from './cdp.mjs';

const APP = (name) => `/tmp/hs-dav/HeliumDav${name === 'A' ? '' : name}.app/Contents/MacOS/Helium`;
const ROOT = '/tmp/hs-dav/root/files/me/Helium Sync';
const checks = [];
const check = (ok, what, detail = '') => { checks.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail === '' ? '' : `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`); };

async function device(name, port) {
  spawn(APP(name), [`--user-data-dir=/tmp/hs-dav/profile-${name}`, '--use-mock-keychain', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${port}`, '--load-extension=/tmp/hs-dav/ext', 'about:blank'], { stdio: 'ignore', detached: true }).unref();
  const browser = await connect(port);
  const sw = await browser.waitTarget((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'));
  const ext = new URL(sw.url).host;
  const worker = await browser.attach(sw.targetId, `worker-${name}`);
  const page = await browser.openPage(`chrome-extension://${ext}/app.html#setup`, `app-${name}`);
  return { browser, worker, page, ext };
}

/** Setup through app.html. A first device reads the key it was given; a joining device pastes `key`. */
async function setUp(d, deviceName, shot, key = null) {
  await d.page.eval(`(() => {
    document.getElementById('webdav').open = true;
    document.getElementById('dav-url').value = 'http://127.0.0.1:8765/files/me/';
    document.getElementById('dav-user').value = 'me';
    document.getElementById('dav-password').value = 's3cret pässword';
    document.getElementById('dav-connect').click();
  })()`);
  if (key !== null) {
    await until(() => d.page.eval(`!document.getElementById('key-enter').hidden || null`), `${deviceName} asks for the sync key`, 20000);
    await d.page.eval(`(() => { const input = document.getElementById('key-input'); input.value = ${JSON.stringify(key)}; input.dispatchEvent(new Event('input')); })()`);
  }
  const preview = await until(() => d.page.eval(`(() => { const p = document.getElementById('preview'); return !p.hidden && !document.getElementById('start').disabled ? p.textContent : null; })()`), `${deviceName} preview`, 20000);
  const label = await d.page.eval(`document.getElementById('store-label').textContent`);
  const shownKey = await d.page.eval(`document.getElementById('key-shown').textContent`);
  await d.page.shot(shot);
  await d.page.eval(`(() => { document.getElementById('name').value = ${JSON.stringify(deviceName)}; document.getElementById('start').click(); })()`);
  const report = await until(() => d.worker.eval(`chrome.storage.local.get('shown').then((r) => r.shown?.report?.kind === 'cycle' && r.shown.report.complete ? r.shown.report : null)`), `${deviceName} first cycle`, 60000);
  return { preview, label, report, key: shownKey };
}

const tree = (d) => d.worker.eval(`chrome.bookmarks.getTree().then((t) => JSON.stringify(t[0].children.map((r) => (r.children ?? []).map((c) => c.title + '|' + (c.url ?? '')).sort())))`);

const A = await device('A', 9351);
await A.worker.eval(`chrome.bookmarks.create({ parentId: '1', title: 'From A', url: 'https://example.com/a' })`);
const a = await setUp(A, 'Device A', '/tmp/hs-dav/shots/1-setup-A.png');
check(a.label === 'Store: Helium Sync on 127.0.0.1:8765', 'A connected to the server', a.label);
check(a.preview.startsWith('New sync folder.'), 'A preview is a new store', a.preview);
check(a.report.store.access === 'ready', 'A cycle ran with the store ready', a.report.store);
check(/^HSK-/.test(a.key), 'A shows a new sync key', a.key);
check(existsSync(`${ROOT}/devices/${a.report.device}/manifest.json`), 'A published its manifest to the server');

const B = await device('B', 9352);
await B.worker.eval(`chrome.bookmarks.create({ parentId: '1', title: 'From B', url: 'https://example.com/b' })`);
const b = await setUp(B, 'Device B', '/tmp/hs-dav/shots/2-setup-B.png', a.key);
check(/^Joining Device A\./.test(b.preview), 'B preview joins A', b.preview);
check((await tree(B)).includes('From A|https://example.com/a'), 'A bookmark reached B');

await A.page.eval(`chrome.runtime.sendMessage({ kind: 'sync-now' })`);
await until(async () => (await tree(A)).includes('From B|https://example.com/b'), 'B bookmark on A', 60000);
check(true, 'B bookmark reached A');
check((await tree(A)) === (await tree(B)), 'A and B bookmark bars match', await tree(A));

const status = await A.browser.openPage(`chrome-extension://${A.ext}/app.html#status`, 'status-A');
await status.eval(`document.getElementById('status-check').click()`);
const checkLine = await until(() => status.eval(`(() => { const t = document.getElementById('fact-folder-detail').textContent; return t === 'Connected.' ? null : t; })()`), 'check access');
check(checkLine === 'Reachable and writable.', 'Check access probes the server', checkLine);
check((await status.eval(`document.getElementById('fact-folder').textContent`)) === 'Helium Sync on 127.0.0.1:8765', 'the dashboard names the server');
console.log('status:', await status.eval(`document.getElementById('status-text').textContent`));
await status.shot('/tmp/hs-dav/shots/3-status-A.png');

const errors = [...A.worker.errors, ...A.page.errors, ...B.worker.errors, ...B.page.errors, ...status.errors];
check(errors.length === 0, 'no errors in worker or pages', errors);
for (const d of [A, B]) await d.browser.call('Browser.close').catch(() => {});
console.log(`${checks.filter(Boolean).length}/${checks.length} passed`);
