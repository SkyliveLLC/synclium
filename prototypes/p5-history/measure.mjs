import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
const db = new DatabaseSync('History', { readOnly: true, readBigInts: true });
const one = (q) => db.prepare(q).get();
// Chrome time: microseconds since 1601-01-01
const nowChrome = (BigInt(Date.now()) + 11644473600000n) * 1000n;
const day = 86400n * 1000000n;
console.log('urls', one('select count(*) n from urls').n, 'visits', one('select count(*) n from visits').n);
const oldest = one('select min(visit_time) t from visits').t;
console.log('span days', oldest ? Number((nowChrome - oldest) / day) : 0);
for (const days of [30n, 90n, 365n]) {
  const since = nowChrome - days * day;
  const rows = db.prepare(`select u.url, u.title, v.visit_time t, v.transition tr from visits v join urls u on u.id=v.url where v.visit_time > ?`).all(since);
  // Shape like a per-device state file: id -> registers with an HLC-ish stamp.
  const stamp = '0lzk3n2ab.0000.3f9c2a1e';
  const state = Object.fromEntries(rows.map((r, i) => [`${r.url}|${r.t}`, { url: [r.url, stamp], title: [r.title, stamp], visitTime: [String(r.t), stamp], transition: [Number(r.tr), stamp], deleted: [false, stamp] }]));
  const json = JSON.stringify(state);
  const urlsOnly = new Map(rows.map(r => [r.url, { title: r.title, last: String(r.t) }]));
  const urlJson = JSON.stringify(Object.fromEntries(urlsOnly));
  console.log(`last ${days}d: visits=${rows.length} distinctUrls=${urlsOnly.size} | per-visit state raw=${(json.length/1024).toFixed(0)}KB gz=${(gzipSync(json).length/1024).toFixed(0)}KB | per-url state raw=${(urlJson.length/1024).toFixed(0)}KB gz=${(gzipSync(urlJson).length/1024).toFixed(0)}KB`);
}
