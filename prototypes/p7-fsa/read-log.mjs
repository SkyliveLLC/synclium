// Prints the probe log from the extension's chrome.storage.local via CDP on the service worker.
const list = await (await fetch('http://localhost:9337/json/list')).json();
const sw = list.find((t) => t.url.startsWith('chrome-extension://') && t.url.endsWith('/sw.js'))
  ?? list.find((t) => t.url.startsWith('chrome-extension://') && t.url.endsWith('/options.html'));
if (!sw) { console.log('probe service worker not found'); process.exit(1); }
const ws = new WebSocket(sw.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: "chrome.storage.local.get('logs').then(r => (r.logs || []).join('\\n'))", awaitPromise: true, returnByValue: true } }));
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id === 1) { console.log(m.result?.result?.value ?? JSON.stringify(m)); ws.close(); } });
