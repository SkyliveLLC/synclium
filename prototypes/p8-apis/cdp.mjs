// Minimal CDP client for the p8 scratch browser on :9350.
// node cdp.mjs eval '<expr>'   -> evaluates in probe worker, prints JSON
// node cdp.mjs page <url> '<expr>' -> opens url, evaluates in that page
// node cdp.mjs quit
const base = 'http://localhost:9350';
const [cmd, ...args] = process.argv.slice(2);
const list = async () => (await fetch(`${base}/json/list`)).json();
async function evalIn(wsUrl, expression) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  const msg = await new Promise((r) => ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id === 1) r(m); }));
  ws.close();
  return msg.result?.exceptionDetails ? { exception: msg.result.exceptionDetails.exception?.description ?? msg.result.exceptionDetails.text } : msg.result?.result?.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function worker() {
  for (let i = 0; i < 20; i++) {
    const t = (await list()).find((x) => x.type === 'service_worker' && x.url.endsWith('/sw.js'));
    if (t) return t;
    await sleep(500);
  }
  throw new Error('probe worker not found');
}
if (cmd === 'eval') console.log(JSON.stringify(await evalIn((await worker()).webSocketDebuggerUrl, args[0]), null, 1));
else if (cmd === 'page') {
  const t = await (await fetch(`${base}/json/new?${args[0]}`, { method: 'PUT' })).json();
  await sleep(2000);
  console.log(JSON.stringify(await evalIn(t.webSocketDebuggerUrl, args[1]), null, 1));
} else if (cmd === 'quit') {
  const v = await (await fetch(`${base}/json/version`)).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
  await new Promise((r) => ws.addEventListener('close', r, { once: true }));
  console.log('closed');
}
