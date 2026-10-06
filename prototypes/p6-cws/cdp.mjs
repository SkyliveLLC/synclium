// Usage: node cdp.mjs <urlPrefixOrNewUrl> <expr> [--new] [--wait ms]
const [,, target, expr, ...flags] = process.argv;
const base = 'http://localhost:9336';
const wait = Number(flags[flags.indexOf('--wait') + 1]) || 0;
const t = flags.includes('--new')
  ? await (await fetch(`${base}/json/new?${target}`, { method: 'PUT' })).json()
  : (await (await fetch(`${base}/json/list`)).json()).find(t => t.url.startsWith(target));
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); pend.get(m.id)?.(m); };
const call = (method, params = {}) => new Promise(r => { pend.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
await new Promise(r => ws.onopen = r);
if (wait) await new Promise(r => setTimeout(r, wait));
const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
console.log(JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails ?? r, null, 1));
ws.close();
