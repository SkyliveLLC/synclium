// Synclium Cloud on the real surface: two fresh scratch Helium profiles set up sync through app.html against the
// production server, with the release build (`npm run build`, loaded unpacked) and no host permission.
// Run: HELIUM=<helium binary> node e2e/cloud.mjs [out dir, default /tmp/hs-cloud]
//   Linux: run under an X display (DISPLAY=:91); profiles get --no-sandbox --password-store=basic.
//   Profiles are made fresh under the out dir; screenshots go to <out dir>/shots/.
// It leaves nothing on the server: both devices forget themselves at the end, and the vault is checked empty.
import { spawn } from 'node:child_process';
import { hkdfSync } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { SCRATCH_HELIUM, connect, sleep, until } from './cdp.mjs';

const SERVER = 'https://synclium.skylive.world';
const OUT = process.argv[2] ?? '/tmp/hs-cloud';
const SHOTS = `${OUT}/shots`;
const DIST = new URL('../dist', import.meta.url).pathname;
const PLATFORM_FLAGS = process.platform === 'linux' ? ['--no-sandbox', '--password-store=basic'] : ['--use-mock-keychain'];
mkdirSync(SHOTS, { recursive: true });

const checks = [];
const check = (ok, what, detail = '') => { checks.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail === '' ? '' : `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`); };

/** The vault token derived here, independently of sync-key.ts: HKDF-SHA256 over the key's 32 bytes, empty salt. */
function vaultToken(shownKey) {
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const digits = shownKey.replace(/^HSK-/, '').replaceAll('-', '');
  const bits = [...digits].reduce((acc, d) => (acc << 5n) | BigInt(ALPHABET.indexOf(d)), 0n) >> 4n; // 52 digits carry 4 pad bits
  const key = Buffer.from(bits.toString(16).padStart(64, '0'), 'hex');
  return Buffer.from(hkdfSync('sha256', key, new Uint8Array(0), 'helium-sync cloud vault v1', 32)).toString('base64url');
}
const vaultDevices = async (shownKey) => (await fetch(`${SERVER}/v1/o/devices/`, { headers: { Authorization: `Bearer ${vaultToken(shownKey)}` } })).json();

/** The same key with its first digit changed: still a valid key, for another, empty vault. */
const typo = (shownKey) => `HSK-${shownKey[4] === '0' ? '1' : '0'}${shownKey.slice(5)}`;

async function device(name, port) {
  const profile = mkdtempSync(`${OUT}/profile-${name}-`);
  spawn(SCRATCH_HELIUM, [`--user-data-dir=${profile}`, ...PLATFORM_FLAGS, '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${port}`, `--load-extension=${DIST}`, 'about:blank'], { stdio: 'ignore', detached: true }).unref();
  const browser = await connect(port);
  const sw = await browser.waitTarget((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'));
  const ext = new URL(sw.url).host;
  const worker = await browser.attach(sw.targetId, `worker-${name}`);
  const page = await browser.openPage(`chrome-extension://${ext}/app.html#setup`, `app-${name}`);
  return { name, browser, worker, page, ext };
}

const report = (d) => d.worker.eval(`chrome.storage.local.get('shown').then((r) => r.shown?.report ?? null)`);
const tree = (d) => d.worker.eval(`chrome.bookmarks.getTree().then((t) => JSON.stringify(t[0].children.map((r) => (r.children ?? []).map((c) => c.title + '|' + (c.url ?? '')).sort())))`);
const setupState = (d) => d.page.eval(`(() => {
  const el = (id) => document.getElementById(id);
  return { label: el('store-label').textContent, keyShown: el('key-new').hidden ? null : el('key-shown').textContent, keyNote: el('key-note').textContent,
    preview: el('preview').hidden ? null : el('preview').textContent, startable: !el('start').disabled };
})()`);
const typeKey = (d, key) => d.page.eval(`(() => { const input = document.getElementById('key-input'); input.value = ${JSON.stringify(key)}; input.dispatchEvent(new Event('input')); })()`);

/** A complete cycle newer than `after`, as the worker reports it. */
const cycleAfter = (d, after, what) => until(async () => { const r = await report(d); return r?.kind === 'cycle' && r.complete && r.at > after ? r : null; }, what, 90000);

async function start(d, deviceName) {
  const before = (await report(d))?.at ?? 0;
  await d.page.eval(`(() => { document.getElementById('name').value = ${JSON.stringify(deviceName)}; document.getElementById('start').click(); })()`);
  return cycleAfter(d, before, `${deviceName} first cycle`);
}

async function syncNow(d) {
  const before = (await report(d)).at;
  await d.page.eval(`chrome.runtime.sendMessage({ kind: 'sync-now' })`);
  return cycleAfter(d, before, `${d.name} cycle after sync-now`);
}

async function forget(d) {
  await d.page.eval(`(() => { window.confirm = () => true; location.hash = '#advanced'; })()`);
  await until(() => d.page.eval(`!document.getElementById('forget').disabled || null`), `${d.name} forget enabled`, 20000);
  await d.page.eval(`document.getElementById('forget').click()`);
  await until(() => d.page.eval(`location.hash === '#setup' || null`), `${d.name} back to setup`, 30000);
}

const A = await device('A', 9461);
await A.worker.eval(`chrome.bookmarks.create({ parentId: '1', title: 'From A', url: 'https://example.com/a' })`);
await A.page.eval(`document.getElementById('cloud-connect').click()`);
const a = await until(async () => { const s = await setupState(A); return s.startable && s.keyShown !== null ? s : null; }, 'A preview', 30000);
check(a.label === 'Store: Synclium Cloud', 'A chose Synclium Cloud', a.label);
check(a.preview?.startsWith('New sync group.'), 'A previews a new sync group', a.preview);
check(/^HSK(-[0-9A-Z]{4}){13}$/.test(a.keyShown), 'A shows a minted key', a.keyShown);
await A.page.shot(`${SHOTS}/1-setup-A.png`);
const aReport = await start(A, 'Device A');
check(aReport.store.access === 'ready', 'A cycle ran with the store ready', aReport.store);

const B = await device('B', 9462);
await B.worker.eval(`chrome.bookmarks.create({ parentId: '1', title: 'From B', url: 'https://example.com/b' })`);
await B.page.eval(`document.getElementById('cloud-connect').click()`);
await until(async () => (await setupState(B)).startable || null, 'B preview of its own new key', 30000);
await typeKey(B, typo(a.keyShown));
const typoState = await until(async () => { const s = await setupState(B); return s.keyNote.startsWith('No device syncs through Synclium Cloud with this key yet') ? s : null; }, 'B typo note', 30000);
check(!typoState.startable, 'a one-digit typo leaves Start disabled', typoState.keyNote);
await B.page.shot(`${SHOTS}/2-typo-B.png`);
await typeKey(B, a.keyShown);
const b = await until(async () => { const s = await setupState(B); return s.startable && s.preview?.startsWith('Joining') ? s : null; }, 'B joining preview', 30000);
check(b.preview.startsWith('Joining Device A.'), 'B previews joining A', b.preview);
const bReport = await start(B, 'Device B');
check(bReport.store.access === 'ready', 'B cycle ran with the store ready', bReport.store);
check((await tree(B)).includes('From A|https://example.com/a'), 'A bookmark reached B');

await syncNow(A);
check((await tree(A)).includes('From B|https://example.com/b'), 'B bookmark reached A');
check((await tree(A)) === (await tree(B)), 'A and B bookmark bars match', await tree(A));

for (const d of [A, B]) {
  const granted = await d.worker.eval(`chrome.permissions.getAll()`);
  check(granted.origins.length === 0, `${d.name} holds no host permission`, granted);
}

// B's next cycle reads A's rewritten manifest; the one after must get a 304 for it.
const responses = [];
B.browser.listeners.push((m) => {
  if (m.sessionId === B.worker.sessionId && m.method === 'Network.responseReceived' && m.params.response.url.startsWith(SERVER))
    responses.push(`${m.params.response.status} ${new URL(m.params.response.url).pathname}`);
});
await B.browser.call('Network.enable', {}, B.worker.sessionId);
await syncNow(B);
responses.length = 0;
await syncNow(B);
console.log('B steady cycle:', responses);
check(responses.includes(`304 /v1/o/devices/${aReport.device}/manifest.json`), 'B gets a 304 for A\'s unchanged manifest', responses);

const status = await B.browser.openPage(`chrome-extension://${B.ext}/app.html#status`, 'status-B');
await sleep(1500);
console.log('B status:', await status.eval(`document.getElementById('status-text').textContent`));
await status.shot(`${SHOTS}/3-status-B.png`);

const listed = await vaultDevices(a.keyShown);
check([aReport.device, bReport.device].every((id) => listed.names?.includes(id)), 'the vault the key derives holds both devices', listed);

await forget(A);
await A.page.eval(`document.getElementById('cloud-connect').click()`);
const afterForget = await until(async () => { const s = await setupState(A); return s.startable && s.keyShown !== null ? s : null; }, 'A preview after forget', 30000);
check(afterForget.keyShown !== a.keyShown, 'setup after forgetting offers a fresh key', afterForget.keyShown);
await forget(B);
const emptied = await vaultDevices(a.keyShown);
console.log('vault after forget:', JSON.stringify(emptied));
check(Array.isArray(emptied.names) && emptied.names.length === 0, 'forget on both empties the vault', emptied);

const errors = [...A.worker.errors, ...A.page.errors, ...B.worker.errors, ...B.page.errors, ...status.errors];
check(errors.length === 0, 'no errors in workers or pages', errors);
for (const d of [A, B]) await d.browser.call('Browser.close').catch(() => {});
console.log(`${checks.filter(Boolean).length}/${checks.length} passed`);
process.exit(checks.every(Boolean) ? 0 : 1);
