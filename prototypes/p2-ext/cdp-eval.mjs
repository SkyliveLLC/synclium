const [,, urlMatch, expr] = process.argv;
const t = (await (await fetch('http://localhost:9334/json/list')).json()).find(t => t.url.startsWith(urlMatch));
const ws = new WebSocket(t.webSocketDebuggerUrl);
ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true } }));
ws.onmessage = (e) => { console.log(JSON.stringify(JSON.parse(e.data).result?.result?.value ?? JSON.parse(e.data))); ws.close(); };
