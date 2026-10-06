const open = () => new Promise((res, rej) => { const r = indexedDB.open('p7', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
export async function put(k, v) { const db = await open(); return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); }
export async function get(k) { const db = await open(); return new Promise((res, rej) => { const r = db.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
export async function log(where, msg) { const { logs = [] } = await chrome.storage.local.get('logs'); logs.push(`${new Date().toISOString()} [${where}] ${msg}`); await chrome.storage.local.set({ logs }); }
export async function probe(where) {
  const h = await get('dir');
  if (!h) return log(where, 'no handle stored');
  let perm; try { perm = await h.queryPermission({ mode: 'readwrite' }); } catch (e) { return log(where, `queryPermission threw ${e}`); }
  await log(where, `queryPermission=${perm}`);
  for (const name of [`probe-${where}.txt`, `probe-${where}.json.gz`, `probe-${where}.hsync`]) {
    try { const f = await h.getFileHandle(name, { create: true }); const w = await f.createWritable(); await w.write(new Date().toISOString()); await w.close(); await log(where, `write OK ${name}`); }
    catch (e) { await log(where, `write FAILED ${name} ${e.name}: ${e.message}`); }
  }
  try {
    const f = await h.getFileHandle(`mtime-${where}.txt`, { create: true });
    let w = await f.createWritable(); await w.write('aaaa'); await w.close();
    const m1 = (await f.getFile()).lastModified;
    await new Promise((r) => setTimeout(r, 2100));
    w = await f.createWritable(); await w.write('bbbb'); await w.close();
    const m2 = (await f.getFile()).lastModified;
    await log(where, `lastModified same-size rewrite: ${m1} -> ${m2} changed=${m2 !== m1}`);
  } catch (e) { await log(where, `mtime check FAILED ${e.name}: ${e.message}`); }
  try { const names = []; for await (const [n] of h.entries()) names.push(n); await log(where, `list OK ${names.join(',')}`); } catch (e) { await log(where, `list FAILED ${e.name}`); }
}
