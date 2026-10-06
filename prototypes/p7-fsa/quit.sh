#!/bin/sh
node --input-type=module <<'JS'
const version = await (await fetch('http://localhost:9337/json/version')).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
await new Promise(resolve => ws.addEventListener('close', resolve, { once: true }));
console.log('scratch quit');
JS
