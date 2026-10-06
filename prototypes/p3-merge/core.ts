// Throwaway prototype: shared model + both merge variants + a fake "dumb sync folder".
import fs from 'node:fs';

export type Kind = 'url' | 'folder';
export type Rec = { kind: Kind; parent: string | null; pos: number; title: string; url?: string };
export type Flat = Map<string, Rec>; // live nodes only, guid -> record

export const ROOT_KEYS = ['bookmark_bar', 'other', 'synced'] as const;
export const OTHER_ROOT = '82b081ec-3dd3-529c-8475-ab6c344590dd';

type ChromiumNode = { guid: string; type: Kind; name: string; url?: string; children?: ChromiumNode[] };

export function loadChromium(path: string): Flat {
  const j = JSON.parse(fs.readFileSync(path, 'utf8')) as { roots: Record<string, ChromiumNode> };
  const flat: Flat = new Map();
  const walk = (n: ChromiumNode, parent: string | null, pos: number) => {
    flat.set(n.guid, { kind: n.type, parent, pos, title: n.name, ...(n.type === 'url' ? { url: n.url } : {}) });
    (n.children ?? []).forEach((c, i) => walk(c, n.guid, i));
  };
  ROOT_KEYS.forEach((k, i) => walk(j.roots[k], null, i));
  return flat;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function childIndex(flat: Flat): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const [g, r] of flat) {
    if (!r.parent) continue;
    let arr = m.get(r.parent);
    if (!arr) m.set(r.parent, (arr = []));
    arr.push(g);
  }
  for (const arr of m.values()) arr.sort((a, b) => flat.get(a)!.pos - flat.get(b)!.pos || cmp(a, b));
  return m;
}

// Browser view: integer positions = index within parent (what Chromium actually exposes).
export function normalize(flat: Flat): Flat {
  const out: Flat = new Map();
  for (const [g, r] of flat) if (!r.parent) out.set(g, { ...r });
  for (const [, arr] of childIndex(flat)) arr.forEach((g, i) => out.set(g, { ...flat.get(g)!, pos: i }));
  return out;
}

export const browserOps = {
  add: (br: Flat, guid: string, rec: Omit<Rec, 'pos'>, index: number) =>
    normalize(new Map(br).set(guid, { ...rec, pos: index - 0.5 })),
  rename: (br: Flat, guid: string, title: string) => new Map(br).set(guid, { ...br.get(guid)!, title }),
  move: (br: Flat, guid: string, parent: string, index: number) =>
    normalize(new Map(br).set(guid, { ...br.get(guid)!, parent, pos: index - 0.5 })),
  remove: (br: Flat, guid: string) => {
    const out = new Map(br);
    const kids = childIndex(br);
    const rm = (g: string) => { out.delete(g); (kids.get(g) ?? []).forEach(rm); };
    rm(guid);
    return normalize(out);
  },
};

// Turn browser indices into stable float positions, keeping the previous view's positions for
// nodes that did not move (greedy increasing run) and interpolating the rest.
export function withPositions(br: Flat, view: Flat): Flat {
  const out: Flat = new Map();
  for (const [g, r] of br) if (!r.parent) out.set(g, { ...r });
  for (const [p, arr] of childIndex(br)) {
    const pos: (number | null)[] = arr.map((g) => {
      const v = view.get(g);
      return v && v.parent === p ? v.pos : null;
    });
    let last = -Infinity;
    for (let i = 0; i < pos.length; i++) {
      if (pos[i] !== null && pos[i]! > last) last = pos[i]!;
      else pos[i] = null;
    }
    let i = 0;
    while (i < arr.length) {
      if (pos[i] !== null) { i++; continue; }
      let j = i;
      while (j < arr.length && pos[j] === null) j++;
      const n = j - i + 1;
      const lo = i > 0 ? pos[i - 1]! : j < arr.length ? pos[j]! - n : 0;
      const hi = j < arr.length ? pos[j]! : lo + n;
      for (let k = i; k < j; k++) pos[k] = lo + ((hi - lo) * (k - i + 1)) / n;
      i = j;
    }
    arr.forEach((g, k) => out.set(g, { ...br.get(g)!, pos: pos[k]! }));
  }
  return out;
}

// A live node whose parent is dead/missing gets re-homed under the nearest live ancestor.
export function rescueOrphans(live: Flat, lookupParent: (g: string) => string | null | undefined): number {
  let rescued = 0;
  for (const [g, r] of live) {
    if (!r.parent || live.has(r.parent)) continue;
    let p: string | null | undefined = r.parent;
    const seen = new Set<string>();
    while (p && !live.has(p) && !seen.has(p)) { seen.add(p); p = lookupParent(p); }
    live.set(g, { ...r, parent: p && live.has(p) ? p : OTHER_ROOT });
    rescued++;
  }
  return rescued;
}

// First sync of a device with a pre-existing tree: map local guids onto remote guids when
// (mapped parent, kind, title, url) match. Top-down so folder adoption carries children.
export function adoptGuids(L: Flat, R: Flat): Map<string, string> {
  const key = (parent: string | null, r: Rec) => `${parent}|${r.kind}|${r.title}|${r.url ?? ''}`;
  const byKey = new Map<string, string>();
  for (const [g, r] of R) if (!byKey.has(key(r.parent, r))) byKey.set(key(r.parent, r), g);
  const map = new Map<string, string>();
  const used = new Set<string>();
  const kids = childIndex(L);
  const visit = (g: string) => {
    const r = L.get(g)!;
    if (!r.parent || R.has(g)) map.set(g, g);
    else {
      const m = byKey.get(key(map.get(r.parent) ?? r.parent, r));
      if (m && !used.has(m) && !L.has(m)) { map.set(g, m); used.add(m); } else map.set(g, g);
    }
    (kids.get(g) ?? []).forEach(visit);
  };
  for (const [g, r] of L) if (!r.parent) visit(g);
  return map;
}

export function remap(L: Flat, map: Map<string, string>): Flat {
  const out: Flat = new Map();
  for (const [g, r] of L) out.set(map.get(g) ?? g, { ...r, parent: r.parent ? (map.get(r.parent) ?? r.parent) : null });
  return out;
}

export function render(flat: Flat): string {
  const kids = childIndex(flat);
  const lines: string[] = [];
  const walk = (g: string, d: number) => {
    const r = flat.get(g)!;
    lines.push(`${'  '.repeat(d)}${g} ${r.kind} ${JSON.stringify(r.title)} ${r.url ?? ''}`);
    (kids.get(g) ?? []).forEach((c) => walk(c, d + 1));
  };
  [...flat].filter(([, r]) => !r.parent).sort((a, b) => a[1].pos - b[1].pos).forEach(([g]) => walk(g, 0));
  return lines.join('\n');
}

export function diff(before: Flat, after: Flat): string[] {
  const out: string[] = [];
  const t = (f: Flat, g: string | null) => (g ? (f.get(g)?.title ?? g.slice(0, 8)) : 'ROOT');
  for (const [g, a] of after) {
    const b = before.get(g);
    if (!b) out.push(`+ ${a.kind} "${a.title}" in "${t(after, a.parent)}"`);
    else {
      if (b.title !== a.title) out.push(`~ "${b.title}" -> "${a.title}"`);
      if (b.parent !== a.parent) out.push(`> "${a.title}" moved "${t(before, b.parent)}" -> "${t(after, a.parent)}"`);
    }
  }
  for (const [g, b] of before) if (!after.has(g)) out.push(`- ${b.kind} "${b.title}"`);
  return out;
}

// ---------- Fake dumb sync folder (Dropbox/iCloud-ish) ----------
export type Mode = 'dropbox' | 'lossy';
type CloudFile = { data: string; rev: number };
type LocalFile = CloudFile & { dirty: boolean };

export class Cloud {
  files = new Map<string, CloudFile>();
  conflicts = 0;
  silentLosses = 0;
  mode: Mode;
  constructor(mode: Mode) { this.mode = mode; }
}
export class Replica {
  files = new Map<string, LocalFile>();
}

export function fwrite(rep: Replica, path: string, data: string) {
  const f = rep.files.get(path);
  if (f && f.data === data && !f.dirty) return; // unchanged content is not an upload
  rep.files.set(path, { data, rev: f?.rev ?? 0, dirty: true });
}

// Upload dirty files. A file whose cloud rev moved since our download is a conflict.
export function push(cloud: Cloud, rep: Replica, devId: string) {
  for (const [p, f] of rep.files) {
    if (!f.dirty) continue;
    const c = cloud.files.get(p);
    if (!c || c.rev === f.rev) {
      cloud.files.set(p, { data: f.data, rev: (c?.rev ?? 0) + 1 });
      f.dirty = false;
      f.rev = (c?.rev ?? 0) + 1;
      continue;
    } else if (cloud.mode === 'dropbox') {
      cloud.conflicts++;
      cloud.files.set(p.replace('.json', ` (${devId} conflicted copy).json`), { data: f.data, rev: 1 });
    } else {
      cloud.silentLosses++;
      cloud.files.set(p, { data: f.data, rev: c.rev + 1 });
    }
    f.dirty = false;
    f.rev = -1;
  }
}

export function pull(cloud: Cloud, rep: Replica) {
  for (const [p, c] of cloud.files) {
    const f = rep.files.get(p);
    if (!f || !f.dirty) rep.files.set(p, { data: c.data, rev: c.rev, dirty: false });
  }
}

// ---------- Device ----------
export type Device = {
  id: string;
  rep: Replica;
  browser: Flat; // what Chromium shows (integer positions)
  view: Flat | null; // last merged view applied to the browser (float positions); null = never synced
  base: Flat | null; // Variant A only: 3-way base
  hlc: { l: number; c: number }; // Variant B only
  skew: number;
};
export type SyncOpts = { now: number; crashAfterWrite?: boolean; adopt?: boolean };

// ---------- Variant A: shared snapshot + 3-way merge ----------
const STORE = 'bookmarks.json';
type RecA = { k: Kind; p: string | null; o: number; t: string; u?: string };

export const encodeA = (f: Flat) =>
  JSON.stringify(Object.fromEntries([...f].map(([g, r]) => [g, { k: r.kind, p: r.parent, o: r.pos, t: r.title, ...(r.url !== undefined ? { u: r.url } : {}) } satisfies RecA])));
export const decodeA = (s: string): Flat =>
  new Map(Object.entries(JSON.parse(s) as Record<string, RecA>).map(([g, r]) => [g, { kind: r.k, parent: r.p, pos: r.o, title: r.t, ...(r.u !== undefined ? { url: r.u } : {}) }]));

export const stats = { conflictsResolved: 0 };

function pick<T>(b: T | undefined, l: T, r: T): T {
  if (l === r) return l;
  if (l === b) return r;
  if (r === b) return l;
  stats.conflictsResolved++;
  return r; // both changed: remote (whoever reached the store first) wins
}

export function merge3(base: Flat, L: Flat, R: Flat): Flat {
  const out: Flat = new Map();
  for (const g of new Set([...base.keys(), ...L.keys(), ...R.keys()])) {
    const b = base.get(g), l = L.get(g), r = R.get(g);
    if (!l && !r) continue;
    if (b && (!l || !r)) continue; // deleted on one side: delete wins
    if (!l || !r) { out.set(g, (l ?? r)!); continue; }
    const loc = pick(b && `${b.parent}|${b.pos}`, `${l.parent}|${l.pos}`, `${r.parent}|${r.pos}`);
    const src = loc === `${l.parent}|${l.pos}` ? l : r;
    out.set(g, { kind: l.kind, parent: src.parent, pos: src.pos, title: pick(b?.title, l.title, r.title), url: pick(b?.url, l.url, r.url) });
    if (out.get(g)!.url === undefined) delete out.get(g)!.url;
  }
  const all = (g: string) => (L.get(g) ?? R.get(g) ?? base.get(g))?.parent;
  rescueOrphans(out, all);
  return out;
}

export function syncA(dev: Device, baseRule: 'naive' | 'remote-read', o: SyncOpts) {
  const raw = dev.rep.files.get(STORE)?.data;
  const R = raw ? decodeA(raw) : new Map();
  let merged: Flat;
  if (!dev.view) {
    if (o.adopt) dev.browser = remap(dev.browser, adoptGuids(dev.browser, R));
    merged = new Map(R);
    for (const [g, r] of dev.browser) if (!R.has(g)) merged.set(g, { ...r, pos: r.parent ? r.pos + 0.5 : r.pos });
    rescueOrphans(merged, (g) => dev.browser.get(g)?.parent);
  } else {
    merged = merge3(dev.base!, withPositions(dev.browser, dev.view), R);
  }
  fwrite(dev.rep, STORE, encodeA(merged));
  if (o.crashAfterWrite) return;
  dev.view = merged;
  dev.browser = normalize(merged);
  dev.base = baseRule === 'naive' ? merged : R;
}

// ---------- Variant B: per-device state files, LWW registers with HLC stamps, merge at read ----------
type Reg<T> = [T, string];
export type RecB = { k: Kind; t: Reg<string>; u?: Reg<string>; l: Reg<[string | null, number]>; d: Reg<boolean> };
export type StateB = Map<string, RecB>;

export const encodeB = (s: StateB) => JSON.stringify(Object.fromEntries(s));
export const decodeB = (s: string): StateB => new Map(Object.entries(JSON.parse(s) as Record<string, RecB>));

const maxReg = <T>(a: Reg<T> | undefined, b: Reg<T> | undefined) => (!a ? b : !b ? a : a[1] >= b[1] ? a : b);

export function mergeAll(states: StateB[]): StateB {
  const out: StateB = new Map();
  for (const s of states)
    for (const [g, r] of s) {
      const cur = out.get(g);
      if (!cur) { out.set(g, r); continue; }
      out.set(g, { k: cur.k, t: maxReg(cur.t, r.t)!, u: maxReg(cur.u, r.u), l: maxReg(cur.l, r.l)!, d: maxReg(cur.d, r.d)! });
    }
  return out;
}

export function materialize(s: StateB): Flat {
  const live: Flat = new Map();
  for (const [g, r] of s)
    if (!r.d[0]) live.set(g, { kind: r.k, parent: r.l[0][0], pos: r.l[0][1], title: r.t[0], ...(r.u ? { url: r.u[0] } : {}) });
  rescueOrphans(live, (g) => s.get(g)?.l[0][0]);
  return live;
}

const enc = (l: number, c: number, id: string) => `${l.toString(36).padStart(9, '0')}.${c.toString(36).padStart(4, '0')}.${id}`;

export function freshRec(r: Rec, stamp: string): RecB {
  return { k: r.kind, t: [r.title, stamp], ...(r.url !== undefined ? { u: [r.url, stamp] as Reg<string> } : {}), l: [[r.parent, r.pos], stamp], d: [false, stamp] };
}

export function syncB(dev: Device, o: SyncOpts) {
  const states = [...dev.rep.files].filter(([p]) => p.startsWith('devices/')).map(([, f]) => decodeB(f.data));
  const S = mergeAll(states);
  let seen = '';
  for (const r of S.values()) for (const reg of [r.t, r.l, r.d, r.u]) if (reg && reg[1] > seen) seen = reg[1];
  const [sl, sc] = seen ? seen.split('.').slice(0, 2).map((x) => parseInt(x, 36)) : [0, 0];
  const wall = o.now + dev.skew;
  const l = Math.max(dev.hlc.l, sl, wall);
  const c = l === wall && l > dev.hlc.l && l > sl ? 0 : 1 + Math.max(l === dev.hlc.l ? dev.hlc.c : -1, l === sl ? sc : -1);
  dev.hlc = { l, c };
  const stamp = enc(dev.hlc.l, dev.hlc.c, dev.id);

  if (!dev.view) {
    if (o.adopt) dev.browser = remap(dev.browser, adoptGuids(dev.browser, materialize(S)));
    for (const [g, r] of dev.browser) if (!S.has(g)) S.set(g, freshRec({ ...r, pos: r.parent ? r.pos + 0.5 : r.pos }, stamp));
  } else {
    const L = withPositions(dev.browser, dev.view);
    for (const [g, r] of L) {
      const v = dev.view.get(g);
      const cur = S.get(g);
      if (!v || !cur) { S.set(g, freshRec(r, stamp)); continue; }
      const next = { ...cur };
      if (v.title !== r.title) next.t = [r.title, stamp];
      if (v.url !== r.url && r.url !== undefined) next.u = [r.url, stamp];
      if (v.parent !== r.parent || v.pos !== r.pos) next.l = [[r.parent, r.pos], stamp];
      S.set(g, next);
    }
    for (const g of dev.view.keys()) if (!L.has(g) && S.has(g)) S.set(g, { ...S.get(g)!, d: [true, stamp] });
  }
  fwrite(dev.rep, `devices/${dev.id}.json`, encodeB(S));
  if (o.crashAfterWrite) return;
  dev.view = materialize(S);
  dev.browser = normalize(dev.view);
}
