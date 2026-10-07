// Minimal CDP client for the p9 scratch browser on :9361.
// node cdp.mjs page <url> '<expr>'  -> opens url in a new tab, evaluates expr (awaited) in it
// node cdp.mjs eval <urlPrefix> '<expr>' -> evaluates in an existing tab whose url starts with prefix
// node cdp.mjs quit                 -> Browser.close
// Another agent's scratch browser may share :9361 on the other loopback family, so pick the
// endpoint whose browser GUID matches the last "DevTools listening" line in OUR log, or refuse.
import { readFileSync } from 'node:fs';
const guidPath = [...readFileSync('/tmp/helium-sync-scratch/p9-profile/helium.log', 'utf8').matchAll(/DevTools listening on ws:\/\/[^/]+(\/devtools\/browser\/[\w-]+)/g)].at(-1)[1];
let base;
for (const host of ['127.0.0.1', '[::1]']) {
  const v = await fetch(`http://${host}:9361/json/version`).then((r) => r.json()).catch(() => null);
  if (v?.webSocketDebuggerUrl?.endsWith(guidPath)) { base = `http://${host}:9361`; break; }
}
if (!base) throw new Error('our scratch browser is not reachable on :9361 (refusing to talk to another one)');
const [cmd, ...args] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function evalIn(wsUrl, expression) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } }));
  const msg = await new Promise((r) => ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id === 1) r(m); }));
  ws.close();
  return msg.result?.exceptionDetails ? { exception: msg.result.exceptionDetails.exception?.description ?? msg.result.exceptionDetails.text } : msg.result?.result?.value;
}
if (cmd === 'page') {
  const t = await (await fetch(`${base}/json/new?${args[0]}`, { method: 'PUT' })).json();
  await sleep(2500);
  console.log(JSON.stringify(await evalIn(t.webSocketDebuggerUrl, args[1] ?? 'location.href'), null, 1));
} else if (cmd === 'eval') {
  const t = (await (await fetch(`${base}/json/list`)).json()).find((x) => x.type === 'page' && x.url.startsWith(args[0]));
  if (!t) throw new Error('no tab ' + args[0]);
  console.log(JSON.stringify(await evalIn(t.webSocketDebuggerUrl, args[1]), null, 1));
} else if (cmd === 'quit') {
  const v = await (await fetch(`${base}/json/version`)).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl.replace('localhost', base.slice(7, -5)));
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
  await new Promise((r) => ws.addEventListener('close', r, { once: true }));
  console.log('closed');
}
