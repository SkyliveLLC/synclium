const [,, method, params] = process.argv;
const v = await (await fetch('http://localhost:9334/json/version')).json();
const ws = new WebSocket(v.webSocketDebuggerUrl);
ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params: JSON.parse(params ?? '{}') }));
ws.onmessage = (e) => { console.log(e.data); ws.close(); };
