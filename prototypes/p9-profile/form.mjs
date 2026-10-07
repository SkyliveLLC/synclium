// Types into a local form through CDP key events (counts as user-typed) and submits it with Enter,
// so Chromium's autocomplete (single-field form history) records the values.
// node form.mjs <url> <fieldId=value>...
import { readFileSync } from 'node:fs';
const guidPath = [...readFileSync('/tmp/helium-sync-scratch/p9-profile/helium.log', 'utf8').matchAll(/DevTools listening on ws:\/\/[^/]+(\/devtools\/browser\/[\w-]+)/g)].at(-1)[1];
const v = await (await fetch('http://127.0.0.1:9361/json/version')).json();
if (!v.webSocketDebuggerUrl.endsWith(guidPath)) throw new Error('not our browser');
const t = await (await fetch(`http://127.0.0.1:9361/json/new?${process.argv[2]}`, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let n = 0;
const call = (method, params = {}) => new Promise((res) => { const id = ++n; const h = (e) => { const m = JSON.parse(e.data); if (m.id === id) { ws.removeEventListener('message', h); res(m.result); } }; ws.addEventListener('message', h); ws.send(JSON.stringify({ id, method, params })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1500);
for (const pair of process.argv.slice(3)) {
  const [id, value] = pair.split('=');
  await call('Runtime.evaluate', { expression: `document.getElementById(${JSON.stringify(id)}).focus()` });
  // Real per-character key events, so the renderer marks the field as user-edited.
  for (const ch of value) {
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
  }
}
await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await sleep(2000);
console.log((await call('Runtime.evaluate', { expression: 'location.href', returnByValue: true })).result.value);
ws.close();
