// Single-profile smoke of the dev build, then the release build. Usage: node smoke.mjs
import { createServer } from 'node:http';
import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { connect, launch, sleep, until } from './cdp.mjs';

const EXT = '/Users/conan/Dev/open-synclium/extension';
const SCRATCH = '/tmp/helium-sync-scratch/u2';
const SHOTS = `${SCRATCH}/shots`;
const PORT = 9338;

const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(`<!doctype html><title>Smoke page ${req.url}</title><p>${req.url}</p>`);
}).listen(8765, '127.0.0.1');

const checks = [];
const check = (ok, what, detail = '') => {
  checks.push({ ok, what });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`);
};

/**
 * Restarts the extension's worker under the debugger from its first line: stop it through the ServiceWorker
 * domain of an extension page, arm auto-attach, and wake it with a message. (chrome.runtime.reload would
 * disable a command-line unpacked extension while developer mode is off.)
 */
async function freshWorker(browser, label) {
  const old = await browser.waitTarget((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'));
  const extId = new URL(old.url).host;
  const page = await browser.openPage(`chrome-extension://${extId}/popup.html`, `${label}-waker`);
  await browser.call('ServiceWorker.enable', {}, page.sessionId);
  await browser.call('ServiceWorker.stopAllWorkers', {}, page.sessionId);
  await until(async () => !(await browser.targets()).some((t) => t.type === 'service_worker' && t.url.includes(extId)), 'worker stopped', 15000);
  const attached = new Promise((resolve) => {
    browser.listeners.push((m) => {
      if (m.method === 'Target.attachedToTarget' && m.params.targetInfo.type === 'service_worker' && m.params.targetInfo.url.includes(extId) && m.params.waitingForDebugger) resolve(m.params);
    });
  });
  const filter = [{ type: 'service_worker', exclude: false }, { type: 'page', exclude: true }];
  await browser.call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter });
  void page.eval(`chrome.runtime.sendMessage({ kind: 'check-store' })`).catch(() => {});
  const { sessionId, targetInfo } = await attached;
  const errors = [];
  browser.listeners.push((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) errors.push(`console.${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  });
  await browser.call('Runtime.enable', {}, sessionId);
  await browser.call('Runtime.runIfWaitingForDebugger', {}, sessionId);
  await browser.call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter });
  await browser.call('Target.closeTarget', { targetId: page.targetId });
  const evaluate = async (expression) => {
    const r = await browser.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  return { extId, errors, eval: evaluate, url: targetInfo.url };
}

const SHOWN = `chrome.storage.local.get('shown').then((r) => r.shown ?? null)`;
const DECODE = `async (b64) => { const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); const nl = bytes.indexOf(10); const body = await new Response(new Blob([bytes.subarray(nl + 1)]).stream().pipeThrough(new DecompressionStream('gzip'))).text(); return JSON.parse(body); }`;

/** No Helium may still hold a scratch profile when it is wiped, or the relaunch finds a half-written profile. */
async function stopScratch() {
  execSync(`pkill -f 'u2/profile' || true`);
  for (let i = 0; i < 40 && execSync(`pgrep -f 'u2/profile' || true`).toString().trim() !== ''; i++) await sleep(250);
  await sleep(500);
}

async function devRun() {
  const profile = `${SCRATCH}/profile`;
  await stopScratch();
  rmSync(profile, { recursive: true, force: true });
  launch({ profile, port: PORT, ext: `${EXT}/dist-dev` });
  const browser = await connect(PORT);
  const worker = await freshWorker(browser, 'dev-worker');
  console.log('dev worker', worker.url);
  check(worker.url.endsWith('/worker-dev.js'), 'dev build runs worker-dev.js');
  await sleep(2000);
  check(worker.errors.length === 0, 'dev worker starts without errors', worker.errors.join(' | '));

  const app = await browser.openPage(`chrome-extension://${worker.extId}/app.html#setup`, 'app-setup');
  await until(() => app.eval(`!document.getElementById('start').disabled`), 'Start enabled');
  console.log('preview:', await app.eval(`document.getElementById('preview').textContent`), '|', await app.eval(`document.getElementById('store-label').textContent`));
  await app.shot(`${SHOTS}/dev-setup.png`);
  await app.eval(`document.getElementById('name').value = 'Scratch A'; document.getElementById('start').click(); true`);
  const first = await until(async () => {
    const s = await worker.eval(SHOWN);
    return s?.report?.kind === 'cycle' ? s : null;
  }, 'first cycle report');
  console.log('first report store', JSON.stringify(first.report.store), 'bookmarks', first.report.bookmarks.kind, 'history', JSON.stringify(first.report.history));
  console.log('setup result:', await app.eval(`document.getElementById('setup-result').textContent`));
  await app.shot(`${SHOTS}/dev-setup-done.png`);
  const device = first.report.device;

  await worker.eval(`chrome.bookmarks.create({ parentId: '1', title: 'Smoke bookmark', url: 'https://example.com/smoke' }).then(() => true)`);
  const published = await until(async () => {
    const raw = await worker.eval(`chrome.storage.local.get('store:devices/${device}/bookmarks.hsync').then((r) => r['store:devices/${device}/bookmarks.hsync'] ?? null)`);
    if (raw === null) return null;
    const body = await worker.eval(`(${DECODE})(${JSON.stringify(raw.b64)})`);
    return JSON.stringify(body).includes('Smoke bookmark') ? body : null;
  }, 'published register file with the new bookmark', 90000);
  check(published !== null, 'creating a bookmark publishes a register file in the dev store', `entries=${Object.keys(published.replica ?? published.entries ?? {}).length}`);
  const manifest = await worker.eval(`chrome.storage.local.get('store:devices/${device}/manifest.json').then((r) => r['store:devices/${device}/manifest.json'])`);
  const manifestBody = JSON.parse(atob(manifest.b64));
  console.log('manifest files:', Object.keys(manifestBody.files), 'seq', manifestBody.seq);
  const report = await worker.eval(SHOWN);
  check(report?.report?.kind === 'cycle' && report.failure === null, 'a SyncReport is in chrome.storage.local', JSON.stringify({ at: report.report.at, store: report.report.store, bookmarks: report.report.bookmarks.kind }));

  const visit = await browser.openPage('http://127.0.0.1:8765/first', 'visit');
  await browser.call('Page.navigate', { url: 'http://127.0.0.1:8765/second' }, visit.sessionId);
  await sleep(3000);
  const searchZero = await worker.eval(`chrome.history.search({ text: '', startTime: 0, maxResults: 0 }).then((r) => r.length)`);
  const searchOne = await worker.eval(`chrome.history.search({ text: '', startTime: 0, maxResults: 1 }).then((r) => r.length)`);
  check(searchZero >= 2 && searchOne === 1, 'history.search maxResults 0 means no limit', `0 -> ${searchZero}, 1 -> ${searchOne}`);
  const today = new Date().toISOString().slice(0, 10);
  const shardKey = `store:devices/${device}/history/${today}.hsync`;
  await app.eval(`chrome.runtime.sendMessage({ kind: 'sync-now' }).then(() => true)`);
  const shard = await until(async () => {
    const raw = await worker.eval(`chrome.storage.local.get(${JSON.stringify(shardKey)}).then((r) => r[${JSON.stringify(shardKey)}] ?? null)`);
    if (raw === null) return null;
    const body = await worker.eval(`(${DECODE})(${JSON.stringify(raw.b64)})`);
    const urls = (body.events ?? []).map((e) => e.url);
    return urls.includes('http://127.0.0.1:8765/first') && urls.includes('http://127.0.0.1:8765/second') ? body : null;
  }, 'own history day shard with both visits', 90000);
  check(true, 'visiting two pages publishes an own history day shard', `${shardKey}: ${shard.events.map((e) => `${e.title} ${e.url}`).join(', ')}`);

  const popup = await browser.openPage(`chrome-extension://${worker.extId}/popup.html`, 'popup');
  console.log('popup text:', await popup.eval(`document.body.innerText`));
  await popup.shot(`${SHOTS}/dev-popup.png`);
  const status = await browser.openPage(`chrome-extension://${worker.extId}/app.html#status`, 'app-status');
  console.log('status text:', await status.eval(`document.querySelector('#status').innerText`));
  await status.shot(`${SHOTS}/dev-status.png`);
  const hist = await browser.openPage(`chrome-extension://${worker.extId}/app.html?q=smoke#history`, 'app-history');
  await sleep(1000);
  console.log('history text:', await hist.eval(`document.querySelector('#history').innerText`));
  await hist.shot(`${SHOTS}/dev-history.png`);
  const adv = await browser.openPage(`chrome-extension://${worker.extId}/app.html#advanced`, 'app-advanced');
  await adv.shot(`${SHOTS}/dev-advanced.png`);
  const pageErrors = [app, popup, status, hist, adv].flatMap((p) => p.errors);
  check(pageErrors.length === 0, 'popup.html and app.html render without console errors', pageErrors.join(' | '));
  check(worker.errors.length === 0, 'dev worker logged no errors during the run', worker.errors.join(' | '));
  const badge = await worker.eval(`chrome.action.getBadgeText({}).then(async (text) => ({ text, title: await chrome.action.getTitle({}) }))`);
  console.log('badge', JSON.stringify(badge));
  browser.close();
  await stopScratch();
}

async function releaseRun() {
  const profile = `${SCRATCH}/profile-release`;
  await stopScratch();
  rmSync(profile, { recursive: true, force: true });
  launch({ profile, port: PORT, ext: `${EXT}/dist` });
  const browser = await connect(PORT);
  const worker = await freshWorker(browser, 'release-worker');
  check(worker.url.endsWith('/worker.js'), 'release build runs worker.js');
  await sleep(2000);
  check(worker.errors.length === 0, 'release worker starts without errors', worker.errors.join(' | '));
  const app = await browser.openPage(`chrome-extension://${worker.extId}/app.html#setup`, 'release-setup');
  await sleep(1000);
  const state = await app.eval(`({ choose: document.getElementById('choose').disabled, start: document.getElementById('start').disabled, note: document.getElementById('choose-note').hidden })`);
  check(state.choose && state.start && !state.note, 'release setup: Choose folder and Start disabled, note shown', JSON.stringify(state));
  const refused = await app.eval(`chrome.runtime.sendMessage({ kind: 'start', name: 'x', historyOn: true })`);
  check(refused.ok && refused.value.kind === 'not-ready', 'release worker refuses Start without a store', JSON.stringify(refused));
  await app.shot(`${SHOTS}/release-setup.png`);
  const popup = await browser.openPage(`chrome-extension://${worker.extId}/popup.html`, 'release-popup');
  console.log('release popup text:', await popup.eval(`document.body.innerText`));
  await popup.shot(`${SHOTS}/release-popup.png`);
  const errors = [...app.errors, ...popup.errors, ...worker.errors];
  check(errors.length === 0, 'release pages and worker without console errors', errors.join(' | '));
  browser.close();
  await stopScratch();
}

try {
  await devRun();
  await releaseRun();
} catch (error) {
  check(false, 'smoke run', error.stack);
  execSync(`pkill -f 'u2/profile' || true`);
} finally {
  server.close();
}
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
