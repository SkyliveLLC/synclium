// Usage: node click.mjs <pageUrlPrefix> <buttonTextRegex>
const [,, pagePrefix, textRe] = process.argv;
const base = 'http://localhost:9336';
const connect = async (url) => {
  const ws = new WebSocket(url);
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id) pend.get(m.id)?.(m); else console.log('EVENT', m.method, JSON.stringify(m.params).slice(0, 300)); };
  await new Promise(r => ws.onopen = r);
  return { ws, call: (method, params = {}) => new Promise(r => { pend.set(++id, r); ws.send(JSON.stringify({ id, method, params })); }) };
};
const browser = await connect((await (await fetch(`${base}/json/version`)).json()).webSocketDebuggerUrl);
await browser.call('Target.setDiscoverTargets', { discover: true });
await browser.call('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: true });
const t = (await (await fetch(`${base}/json/list`)).json()).find(t => t.url.startsWith(pagePrefix));
const page = await connect(t.webSocketDebuggerUrl);
await page.call('Page.bringToFront');
const rect = (await page.call('Runtime.evaluate', { returnByValue: true, expression:
  `(() => { const b = [...document.querySelectorAll('button')].find(b => new RegExp(${JSON.stringify(textRe)}).test(b.innerText)); b.scrollIntoView({block:'center'}); const r = b.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2, w: r.width, h: r.height, text: b.innerText }; })()` })).result.result.value;
console.log('button', rect);
for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
  console.log(type, JSON.stringify((await page.call('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 })).result));
await new Promise(r => setTimeout(r, 10000));
const after = await page.call('Runtime.evaluate', { returnByValue: true, expression:
  `[...document.querySelectorAll('button')].filter(b=>/add|remove|install|helium/i.test(b.innerText)).map(b=>b.innerText.trim()+(b.disabled?' (disabled)':''))` });
console.log('buttons after', JSON.stringify(after.result.result.value));
process.exit(0);
