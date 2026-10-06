// Throwaway: runs every scenario against A-naive, A (base = last remote read), and B, in both folder modes.
import {
  Cloud, Replica, push, pull, browserOps as op, loadChromium, normalize, render, diff, syncA, syncB,
  encodeA, encodeB, freshRec, stats, type Device, type Flat, type Mode, type SyncOpts,
} from './core.ts';

const GROUND = loadChromium('/tmp/helium-sync-scratch/ground/Bookmarks');
const BAR = '0bc5d13f-2cba-5d74-951f-3f233fe6c908';
const urls = [...GROUND].filter(([, r]) => r.kind === 'url').map(([g]) => g);
const F = '63a2eb7c-97ec-4976-ad2e-a266963de046'; // folder "Vue" (2 children)
const b = urls.find((g) => GROUND.get(g)!.parent !== F)!;
const u = urls.filter((g) => g !== b && GROUND.get(g)!.parent !== F).slice(10);
const title = (g: string) => GROUND.get(g)!.title;
const DAY = 86_400_000;

type VariantName = 'A-naive' | 'A' | 'B';
type Ctx = {
  dev: Record<string, Device>;
  edit: (id: string, f: (br: Flat) => Flat) => void;
  sync: (id: string, extra?: Partial<SyncOpts>) => void;
  push: (id: string) => void;
  pull: (id: string) => void;
  cycle: (id: string) => void;
  tick: (ms: number) => void;
  join: (id: string, browser: Flat) => void;
};
type Scenario = {
  name: string;
  devices: string[];
  skew?: Record<string, number>;
  adopt?: boolean;
  run: (c: Ctx) => void;
  expect: (final: Flat) => Record<string, boolean>;
};

const findTitle = (f: Flat, t: string) => [...f].filter(([, r]) => r.title === t);
const dupCount = (f: Flat) => {
  const seen = new Map<string, number>();
  for (const r of f.values()) if (r.kind === 'url') {
    const k = `${r.parent}|${r.title}|${r.url}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  return [...seen.values()].filter((n) => n > 1).reduce((a, n) => a + n - 1, 0);
};
const GROUND_DUPS = dupCount(GROUND);
const newUrl = (t: string) => ({ kind: 'url' as const, parent: BAR, title: t, url: `https://example.com/${t}` });

// Z: same tree but 3 urls + folder "IA" (and its children) re-guided, plus a Z-only bookmark.
// Keeps urls[0] with the same guid, which X deletes before Z joins.
function zTree(): Flat {
  const reguid = new Set([u[20], u[21], u[22], '29ebe18c-a4cc-400a-be9a-8409b4fdc507']);
  for (const [g, r] of GROUND) if (r.parent === '29ebe18c-a4cc-400a-be9a-8409b4fdc507') reguid.add(g);
  const map = new Map([...reguid].map((g) => [g, crypto.randomUUID()]));
  let z: Flat = new Map();
  for (const [g, r] of GROUND) z.set(map.get(g) ?? g, { ...r, parent: r.parent ? (map.get(r.parent) ?? r.parent) : null });
  z = normalize(z);
  return op.add(z, 'z-only', newUrl('z-only'), 0);
}

const scenarios: Scenario[] = [
  {
    name: '1 concurrent add + rename-other',
    devices: ['X', 'Y'],
    run: (c) => {
      c.edit('X', (br) => op.add(br, 'n1', newUrl('n1'), 0));
      c.edit('Y', (br) => op.rename(br, u[1], 'Y-renamed'));
      c.sync('X'); c.sync('Y'); c.push('X'); c.push('Y'); c.pull('X'); c.pull('Y');
    },
    expect: (f) => ({ 'X add kept': f.has('n1'), 'Y rename kept': f.get(u[1])?.title === 'Y-renamed' }),
  },
  {
    name: '2 move-into-F vs delete-F',
    devices: ['X', 'Y'],
    run: (c) => {
      c.edit('X', (br) => op.move(br, b, F, 0));
      c.edit('Y', (br) => op.remove(br, F));
      c.sync('X'); c.sync('Y'); c.push('X'); c.push('Y'); c.pull('X'); c.pull('Y');
    },
    expect: (f) => ({ 'F deleted': !f.has(F), 'moved bookmark survives': f.has(b), 'X move not reverted': f.get(b)?.parent !== GROUND.get(b)!.parent }),
  },
  {
    name: '3 same-field rename (Y 1s later)',
    devices: ['X', 'Y'],
    run: (c) => {
      c.edit('X', (br) => op.rename(br, u[2], 'X-title'));
      c.sync('X');
      c.tick(1000);
      c.edit('Y', (br) => op.rename(br, u[2], 'Y-title'));
      c.sync('Y'); c.push('X'); c.push('Y'); c.pull('X'); c.pull('Y');
    },
    expect: (f) => ({ 'later edit (Y) wins': f.get(u[2])?.title === 'Y-title' }),
  },
  {
    name: '3b same as 3, Y clock 10min slow',
    devices: ['X', 'Y'],
    skew: { Y: -600_000 },
    run: (c) => {
      c.edit('X', (br) => op.rename(br, u[2], 'X-title'));
      c.sync('X');
      c.tick(1000);
      c.edit('Y', (br) => op.rename(br, u[2], 'Y-title'));
      c.sync('Y'); c.push('X'); c.push('Y'); c.pull('X'); c.pull('Y');
    },
    expect: (f) => ({ 'later edit (Y) wins': f.get(u[2])?.title === 'Y-title' }),
  },
  {
    name: '4 X offline a week',
    devices: ['X', 'Y'],
    run: (c) => {
      c.edit('X', (br) => op.add(op.rename(br, u[3], 'X-offline'), 'n4', newUrl('n4'), 0));
      c.sync('X'); // offline: writes local replica only
      c.tick(3 * DAY);
      c.edit('Y', (br) => op.rename(op.rename(br, u[3], 'Y-day3'), u[5], 'Y-other'));
      c.cycle('Y');
      c.tick(3 * DAY);
      c.edit('X', (br) => op.rename(br, u[6], 'X-day6'));
      c.sync('X'); // still offline
      c.tick(DAY);
      c.push('X'); c.pull('X'); // back online
    },
    expect: (f) => ({
      'X offline add kept': f.has('n4'),
      'X day6 rename kept': f.get(u[6])?.title === 'X-day6',
      'Y rename kept': f.get(u[5])?.title === 'Y-other',
      'u3: later (Y day3) wins': f.get(u[3])?.title === 'Y-day3',
    }),
  },
  {
    name: '5 crash after store write',
    devices: ['X', 'Y'],
    run: (c) => {
      c.edit('Y', (br) => op.rename(br, u[8], 'Y-8'));
      c.cycle('Y');
      c.edit('X', (br) => op.rename(op.add(br, 'n5', newUrl('n5'), 0), u[7], 'X-7'));
      c.pull('X');
      c.sync('X', { crashAfterWrite: true });
      c.push('X');
      c.sync('X'); // rerun after crash
      c.push('X');
    },
    expect: (f) => ({
      'n5 exactly once': findTitle(f, 'n5').length === 1,
      'X rename kept': f.get(u[7])?.title === 'X-7',
      'Y rename kept': f.get(u[8])?.title === 'Y-8',
    }),
  },
  {
    name: '6 Z joins with own tree (adopt on)',
    devices: ['X', 'Y'],
    adopt: true,
    run: (c) => {
      c.edit('X', (br) => op.remove(br, urls[0]));
      c.cycle('X'); c.cycle('Y');
      c.join('Z', zTree());
    },
    expect: (f) => ({
      'no duplicates': dupCount(f) === GROUND_DUPS,
      'X delete stays deleted': !f.has(urls[0]),
      'Z-only kept': f.has('z-only'),
    }),
  },
  {
    name: '6b Z joins (adopt off)',
    devices: ['X', 'Y'],
    adopt: false,
    run: (c) => {
      c.edit('X', (br) => op.remove(br, urls[0]));
      c.cycle('X'); c.cycle('Y');
      c.join('Z', zTree());
    },
    expect: (f) => ({
      'no duplicates': dupCount(f) === GROUND_DUPS,
      'X delete stays deleted': !f.has(urls[0]),
      'Z-only kept': f.has('z-only'),
    }),
  },
  {
    name: '7 X adds, Y deletes it before X resyncs',
    devices: ['X', 'Y'],
    run: (c) => {
      c.edit('X', (br) => op.add(br, 'n7', newUrl('n7'), 0));
      c.cycle('X');
      c.pull('Y'); c.sync('Y');
      c.edit('Y', (br) => op.remove(br, 'n7'));
      c.cycle('Y');
      c.pull('X');
    },
    expect: (f) => ({ 'Y delete honored': !f.has('n7') }),
  },
];

function runOne(variant: VariantName, mode: Mode, sc: Scenario) {
  const cloud = new Cloud(mode);
  let now = 1_760_000_000_000;
  const T0 = now;
  const dev: Record<string, Device> = {};
  const seedB = encodeB(new Map([...GROUND].map(([g, r]) => [g, freshRec(r, `${(T0 - DAY).toString(36).padStart(9, '0')}.0000.seed`)])));
  const mk = (id: string, browser: Flat, synced: boolean): Device => ({
    id, rep: new Replica(), browser, view: synced ? GROUND : null, base: synced ? GROUND : null,
    hlc: { l: 0, c: 0 }, skew: sc.skew?.[id] ?? 0,
  });
  for (const id of sc.devices) dev[id] = mk(id, normalize(GROUND), true);
  if (variant === 'B') for (const id of sc.devices) cloud.files.set(`devices/${id}.json`, { data: seedB, rev: 1 });
  else cloud.files.set('bookmarks.json', { data: encodeA(GROUND), rev: 1 });
  for (const d of Object.values(dev)) pull(cloud, d.rep);

  const doSync = (id: string, extra: Partial<SyncOpts> = {}) => {
    const o: SyncOpts = { now, adopt: sc.adopt, ...extra };
    if (variant === 'B') syncB(dev[id], o);
    else syncA(dev[id], variant === 'A-naive' ? 'naive' : 'remote-read', o);
  };
  const c: Ctx = {
    dev,
    edit: (id, f) => { dev[id].browser = f(dev[id].browser); },
    sync: doSync,
    push: (id) => push(cloud, dev[id].rep, id),
    pull: (id) => pull(cloud, dev[id].rep),
    cycle: (id) => { pull(cloud, dev[id].rep); doSync(id); push(cloud, dev[id].rep, id); },
    tick: (ms) => { now += ms; },
    join: (id, browser) => { dev[id] = mk(id, browser, false); c.cycle(id); },
  };
  stats.conflictsResolved = 0;
  sc.run(c);
  const conflictsDuringRun = cloud.conflicts + cloud.silentLosses;
  for (let round = 0; round < 4; round++) for (const id of Object.keys(dev)) { c.tick(1000); c.cycle(id); }
  const snap = Object.values(dev).map((d) => render(d.browser));
  for (const id of Object.keys(dev)) { c.tick(1000); c.cycle(id); }
  const snap2 = Object.values(dev).map((d) => render(d.browser));
  const converged = snap.every((s) => s === snap[0]) && snap2.every((s, i) => s === snap[i]);
  const final = Object.values(dev)[0].view!;
  if (!converged) for (const d of Object.values(dev).slice(1)) console.log(`    !! ${d.id} vs first device:`, diff(final, d.view!).join(' | '));
  const checks = sc.expect(final);
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  return {
    converged, failed, final,
    folderConflicts: conflictsDuringRun,
    leftoverCopies: [...cloud.files.keys()].filter((p) => p.includes('conflicted')).length,
    tieBreaks: stats.conflictsResolved,
  };
}

const variants: VariantName[] = ['A-naive', 'A', 'B'];
const rows: string[] = [];
for (const sc of scenarios) {
  console.log(`\n=== ${sc.name} ===`);
  for (const mode of ['dropbox', 'lossy'] as Mode[]) {
    for (const v of variants) {
      const r = runOne(v, mode, sc);
      const d = diff(GROUND, r.final);
      const shown = d.length > 8 ? [...d.slice(0, 8), `... (${d.length} changes)`] : d;
      console.log(`[${v} / ${mode}] converged=${r.converged} folderConflicts=${r.folderConflicts} leftoverCopies=${r.leftoverCopies} lost=${r.failed.length ? r.failed.join('; ') : 'none'}`);
      console.log(shown.map((x) => '    ' + x).join('\n'));
      rows.push(`${sc.name.padEnd(42)} ${mode.padEnd(8)} ${v.padEnd(8)} conv=${r.converged ? 'Y' : 'N'} lost=${r.failed.length ? r.failed.join('; ') : '-'}`);
    }
  }
}
console.log('\n=== SUMMARY ===\n' + rows.join('\n'));
void title;
