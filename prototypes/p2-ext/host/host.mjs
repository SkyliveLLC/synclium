import fs from 'node:fs';
import net from 'node:net';
const LOG = '/tmp/helium-sync-scratch/p2-ext/host.log';
const SOCK = '/tmp/helium-sync-scratch/p2-ext/host.sock';
const start = Date.now();
const log = (...a) => fs.appendFileSync(LOG, `[pid ${process.pid} +${((Date.now() - start) / 1000).toFixed(1)}s] ${a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')}\n`);
log('host started argv=', process.argv.slice(2), 'ppid=', process.ppid);
let reqId = 0;
const pending = new Map();
const send = (cmd, extra = {}) => new Promise((res) => {
  const id = ++reqId; pending.set(id, res);
  const b = Buffer.from(JSON.stringify({ reqId: id, cmd, ...extra }));
  const h = Buffer.alloc(4); h.writeUInt32LE(b.length);
  process.stdout.write(Buffer.concat([h, b]));
});
let buf = Buffer.alloc(0);
process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const msg = JSON.parse(buf.subarray(4, 4 + len).toString()); buf = buf.subarray(4 + len);
    if (msg.reqId && pending.has(msg.reqId)) { pending.get(msg.reqId)(msg); pending.delete(msg.reqId); }
    else log('unsolicited', msg);
  }
});
process.stdin.on('end', () => { log('stdin closed, exiting'); process.exit(0); });
try { fs.unlinkSync(SOCK); } catch {}
net.createServer((c) => c.on('data', async (d) => {
  const { cmd, ...rest } = JSON.parse(d.toString());
  const r = await send(cmd, rest); log('via-socket', cmd, r); c.end(JSON.stringify(r) + '\n');
})).listen(SOCK, () => log('relay socket listening', SOCK));
const flatten = (nodes, out = []) => { for (const n of nodes) { out.push(n); if (n.children) flatten(n.children, out); } return out; };
(async () => {
  const t1 = await send('getTree');
  log('tree1 nodes=', flatten(t1.result).length, 'titles=', flatten(t1.result).map(n => n.title));
  log('nodeKeys', (await send('nodeKeys')).result);
  const c = await send('create', { title: 'p2 created', url: 'https://example.com/p2' });
  log('create', c);
  log('createWithId', await send('createWithId', { title: 'p2 fixed', url: 'https://example.com/fixed' }));
  const t2 = await send('getTree');
  log('tree2 has created?', flatten(t2.result).filter(n => n.url?.includes('example.com')).map(n => ({ id: n.id, title: n.title, syncing: n.syncing, folderType: n.folderType })));
  log('historyAdd', (await send('historyAdd', { url: 'https://example.org/hist' })).result);
  log('mgmt', (await send('mgmt')).result);
  log('sessions', (await send('sessions')).result);
  log('probe', (await send('probe')).result);
  log('tabs', (await send('tabs')).result);
  const gaps = [40, 70, 100];
  for (const [i, g] of gaps.entries()) { await new Promise(r => setTimeout(r, g * 1000)); const r = await send('ping', { n: i + 1 }); log('heartbeat after idle', g + 's', r.result); }
  log('idle test done');
})();
