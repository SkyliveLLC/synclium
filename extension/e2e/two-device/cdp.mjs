// Tiny CDP helper for the e2e scratch devices. Usage: node cdp.mjs <A|B> <command> [args]
// Commands: bm-list | bm-add <title> <url> | status | open <page-path> | quit
const [dev, cmd, ...args] = process.argv.slice(2);
const port = dev === 'A' ? 9340 : 9341;
const base = `http://localhost:${port}`;
const list = async () => (await fetch(`${base}/json/list`)).json();
async function evalIn(target, expression) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  const msg = await new Promise((r) => ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id === 1) r(m); }));
  ws.close();
  if (msg.result?.exceptionDetails) throw new Error(JSON.stringify(msg.result.exceptionDetails));
  return msg.result?.result?.value;
}
async function bookmarksTarget() {
  let t = (await list()).find((x) => x.url.startsWith('chrome://bookmarks'));
  if (!t) { await fetch(`${base}/json/new?chrome://bookmarks/`, { method: 'PUT' }); await new Promise((r) => setTimeout(r, 1500)); t = (await list()).find((x) => x.url.startsWith('chrome://bookmarks')); }
  return t;
}
async function extWorker() {
  const t = (await list()).find((x) => x.type === 'service_worker' && x.url.startsWith('chrome-extension://') && x.url.endsWith('/worker.js'));
  if (!t) throw new Error('Synclium worker not found (installed? asleep? open its popup or app page to wake it)');
  return t;
}
const flat = `chrome.bookmarks.getTree().then(t => { const out = []; const walk = (n, path) => { for (const c of n.children || []) { if (c.url) out.push(path + ' > ' + c.title + ' | ' + c.url); else walk(c, path + ' > ' + c.title); } }; walk(t[0], ''); return out.join('\\n'); })`;
if (cmd === 'bm-list') console.log(await evalIn(await bookmarksTarget(), flat) || '(no bookmarks)');
else if (cmd === 'bm-add') console.log(await evalIn(await bookmarksTarget(), `chrome.bookmarks.create({ parentId: '1', title: ${JSON.stringify(args[0])}, url: ${JSON.stringify(args[1])} }).then(n => 'created ' + n.id)`));
else if (cmd === 'status') console.log(await evalIn(await extWorker(), `chrome.storage.local.get(null).then(v => JSON.stringify(v, null, 1).slice(0, 4000))`));
else if (cmd === 'open') { const sw = await extWorker(); const id = sw.url.split('/')[2]; await fetch(`${base}/json/new?chrome-extension://${id}/${args[0]}`, { method: 'PUT' }); console.log(`opened chrome-extension://${id}/${args[0]}`); }
else if (cmd === 'quit') { const v = await (await fetch(`${base}/json/version`)).json(); const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener('open', r, { once: true })); ws.send(JSON.stringify({ id: 1, method: 'Browser.close' })); await new Promise((r) => ws.addEventListener('close', r, { once: true })); console.log(`scratch device ${dev} quit`); }
else { console.log('unknown command'); process.exit(1); }
