// A set-up device presses Start again on the same folder (Change folder picking the folder it already uses):
// its old identity's files must leave the folder, and only the new device remains.
import { connect, sleep, until } from './cdp.mjs';
const browser = await connect(9339);
const sw = await browser.waitTarget((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'));
const extId = new URL(sw.url).host;
const worker = await browser.attach(sw.targetId, 'worker');
const SHOWN = `chrome.storage.local.get('shown').then((r) => r.shown ?? null)`;
const LIST = `(async () => { const d = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('Helium Sync')).getDirectoryHandle('devices'); const n = []; for await (const k of d.keys()) n.push(k); return n.sort(); })()`;
const page = await browser.openPage(`chrome-extension://${extId}/app.html#setup`, 'app');
const old = (await worker.eval(SHOWN)).report.device;
console.log('before:', old, await page.eval(LIST));
await until(() => page.eval(`!document.getElementById('start').disabled`), 'Start enabled');
await page.eval(`document.getElementById('start').click(); true`);
const fresh = await until(async () => { const s = await worker.eval(SHOWN); return s?.report?.kind === 'cycle' && s.report.device !== old && s.report.store.access === 'ready' ? s.report : null; }, 'new device cycle', 90000);
await sleep(1000);
const after = await page.eval(LIST);
console.log('after:', fresh.device, after, 'peers', JSON.stringify(fresh.peers));
console.log(JSON.stringify(after) === JSON.stringify([fresh.device]) && fresh.peers.length === 0 ? 'PASS old identity left the folder, no self-peer' : 'FAIL');
console.log('errors:', [...worker.errors, ...page.errors].join(' | ') || 'none');
browser.close();
