// Throwaway: store sizes and merge timings for A (3-way) and B (merge 3 device files), 500 vs 50k nodes.
import zlib from 'node:zlib';
import fs from 'node:fs';
import {
  loadChromium, encodeA, decodeA, merge3, encodeB, decodeB, mergeAll, materialize, freshRec,
  type Flat, type StateB,
} from './core.ts';

const BAR = '0bc5d13f-2cba-5d74-951f-3f233fe6c908';

function synth(n: number): Flat {
  const f = loadChromium('/tmp/helium-sync-scratch/ground/Bookmarks');
  for (const [g, r] of [...f]) if (r.parent) f.delete(g);
  let folder = BAR, inFolder = 0, folderIdx = 0;
  for (let i = 0; f.size < n; i++) {
    if (inFolder === 0) {
      folder = crypto.randomUUID();
      f.set(folder, { kind: 'folder', parent: BAR, pos: folderIdx++, title: `Folder ${folderIdx}` });
    }
    f.set(crypto.randomUUID(), { kind: 'url', parent: folder, pos: inFolder, title: `Some page title number ${i} - Example Site`, url: `https://www.example${i % 997}.com/path/to/page/${i}?q=${i}` });
    inFolder = (inFolder + 1) % 50;
  }
  return f;
}

const stamp = (t: number, id: string) => `${t.toString(36).padStart(9, '0')}.0000.${id}`;
function deviceState(base: Flat, id: string, editFrac: number): StateB {
  const s: StateB = new Map([...base].map(([g, r]) => [g, freshRec(r, stamp(1_760_000_000_000, 'seed'))]));
  let i = 0;
  for (const [g, r] of s) if (i++ % Math.round(1 / editFrac) === 0) s.set(g, { ...r, t: [r.t[0] + ` (${id})`, stamp(1_760_000_100_000, id)] });
  return s;
}
function edited(base: Flat, tag: string, editFrac: number): Flat {
  const out = new Map(base);
  let i = 0;
  for (const [g, r] of base) if (i++ % Math.round(1 / editFrac) === 0) out.set(g, { ...r, title: r.title + tag });
  return out;
}
const time = (fn: () => void, reps: number) => {
  fn();
  const t = performance.now();
  for (let i = 0; i < reps; i++) fn();
  return ((performance.now() - t) / reps).toFixed(2);
};
const kb = (n: number) => (n / 1024).toFixed(1) + 'KB';

const real = loadChromium('/tmp/helium-sync-scratch/ground/Bookmarks');
console.log(`original Chromium Bookmarks file: ${kb(fs.statSync('/tmp/helium-sync-scratch/ground/Bookmarks').size)}, gzip ${kb(zlib.gzipSync(fs.readFileSync('/tmp/helium-sync-scratch/ground/Bookmarks')).length)}`);

for (const [label, base] of [['real 500', real], ['synth 50k', synth(50_000)]] as const) {
  const a = encodeA(base);
  const bs = ['X', 'Y', 'Z'].map((id) => encodeB(deviceState(base, id, 0.01)));
  console.log(`\n${label}: ${base.size} nodes`);
  console.log(`  A shared file:      ${kb(a.length)} raw, ${kb(zlib.gzipSync(a).length)} gzip`);
  console.log(`  B one device file:  ${kb(bs[0].length)} raw, ${kb(zlib.gzipSync(bs[0]).length)} gzip  (x3 devices = ${kb(bs.reduce((s, x) => s + x.length, 0))})`);

  const L = edited(base, ' L', 0.01), Rr = edited(base, ' R', 0.013);
  const reps = base.size > 10_000 ? 5 : 200;
  console.log(`  A 3-way merge (in-memory):           ${time(() => merge3(base, L, Rr), reps)} ms`);
  console.log(`  A parse store + 3-way:               ${time(() => merge3(base, L, decodeA(a)), reps)} ms`);
  console.log(`  B parse 3 files + merge + materialize: ${time(() => materialize(mergeAll(bs.map(decodeB))), reps)} ms`);
  const parsed = bs.map(decodeB);
  console.log(`  B mergeAll+materialize (no parse):   ${time(() => materialize(mergeAll(parsed)), reps)} ms`);
  console.log(`  B parse 3 files:                     ${time(() => bs.map(decodeB), reps)} ms`);
}
