// Bookmarks as a register type. chrome.bookmarks never appears here (see chrome-bookmarks.ts).
import { isItemId, type AdoptInput, type Adoption, type Brand, type ItemId, type Live, type RegisterType } from './model.ts';

/** Fractional index. String order is display order within a folder. Minted between neighbours, never renumbered. */
export type Position = Brand<string, 'Position'>;

/** Parent and position share one register, so concurrent moves never split a node's parent from its order. */
export type Location = { readonly parent: ItemId; readonly pos: Position };

export type Bookmark =
  | { readonly kind: 'folder'; readonly title: string; readonly location: Location }
  | { readonly kind: 'url'; readonly title: string; readonly url: string; readonly location: Location };

function root(guid: string): ItemId {
  if (!isItemId(guid)) throw new Error(`bad root guid ${guid}`);
  return guid;
}

/**
 * Chromium's well-known permanent folder guids. Roots are not records. They are never created, renamed,
 * or deleted, and they are the same on every device, so they need no adoption.
 */
export const ROOTS = {
  bar: root('0bc5d13f-2cba-5d74-951f-3f233fe6c908'),
  other: root('82b081ec-3dd3-529c-8475-ab6c344590dd'),
  mobile: root('4cf2e351-0e85-532b-bb37-df045d8f8d0f'),
} as const;

const ROOT_IDS: ReadonlySet<ItemId> = new Set(Object.values(ROOTS));
export const isRoot = (id: ItemId): boolean => ROOT_IDS.has(id);

// ---------- Positions ----------

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
/** Base-36 digits with no trailing zero, so every key has a key strictly between it and any other. */
const POSITION = /^[0-9a-z]*[1-9a-z]$/;
export const isPosition = (s: string): s is Position => POSITION.test(s);

/** A key strictly between `lo` and `hi`. `''` is the lower bound, `null` the upper. */
export function between(lo: string, hi: string | null): Position {
  const key = midpoint(lo, hi);
  if (!isPosition(key)) throw new Error(`bad position ${key} between ${lo} and ${hi}`);
  return key;
}

function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let common = 0;
    while (common < b.length && (a[common] ?? DIGITS[0]) === b[common]) common++;
    if (common > 0) return b.slice(0, common) + midpoint(a.slice(common), b.slice(common));
  }
  const da = a === '' ? 0 : DIGITS.indexOf(a[0] ?? '0');
  const db = b === null ? DIGITS.length : DIGITS.indexOf(b[0] ?? '0');
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)] ?? '';
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return (DIGITS[da] ?? '') + midpoint(a.slice(1), null);
}

/** `n` keys strictly between `lo` and `hi`, spread so neighbours stay short. */
function mintBetween(lo: string, hi: string | null, n: number): Position[] {
  if (n === 0) return [];
  const mid = between(lo, hi);
  const left = Math.floor((n - 1) / 2);
  return [...mintBetween(lo, mid, left), mid, ...mintBetween(mid, hi, n - 1 - left)];
}

/** Indexes of a longest strictly increasing run. Patience sorting, O(n log n). */
function longestIncreasingRun(values: readonly (string | null)[]): ReadonlySet<number> {
  const tails: number[] = [];
  const prev: (number | null)[] = values.map(() => null);
  values.forEach((value, i) => {
    if (value === null) return;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const at = values[tails[mid] ?? 0];
      if (at !== null && at !== undefined && at < value) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo > 0 ? (tails[lo - 1] ?? null) : null;
    tails[lo] = i;
  });
  const kept = new Set<number>();
  for (let at: number | null = tails[tails.length - 1] ?? null; at !== null; at = prev[at] ?? null) kept.add(at);
  return kept;
}

/**
 * Browser order to stable positions. Keeps `previous` positions for the longest run of children still in
 * order and mints keys between them for the rest. Without this, every read looks like a reorder of the folder.
 */
export function placeChildren(children: ReadonlyMap<ItemId, readonly ItemId[]>, previous: Live<Bookmark> | null): ReadonlyMap<ItemId, Location> {
  const out = new Map<ItemId, Location>();
  for (const [parent, ids] of children) {
    const held = ids.map((id) => {
      const was = previous?.get(id)?.location;
      return was !== undefined && was.parent === parent ? was.pos : null;
    });
    const kept = longestIncreasingRun(held);
    const pos: (Position | null)[] = held.map((p, i) => (kept.has(i) ? p : null));
    let i = 0;
    while (i < ids.length) {
      if (pos[i] !== null) {
        i++;
        continue;
      }
      let j = i;
      while (j < ids.length && pos[j] === null) j++;
      const lo = i > 0 ? (pos[i - 1] ?? '') : '';
      const hi = j < ids.length ? (pos[j] ?? null) : null;
      mintBetween(lo, hi, j - i).forEach((p, k) => (pos[i + k] = p));
      i = j;
    }
    ids.forEach((id, k) => {
      const p = pos[k];
      if (p === null || p === undefined) throw new Error('unplaced child');
      out.set(id, { parent, pos: p });
    });
  }
  return out;
}

/** Display order within one folder: position, then id for the ties normalize can create. */
export const byPosition = (a: readonly [ItemId, Bookmark], b: readonly [ItemId, Bookmark]): number =>
  a[1].location.pos < b[1].location.pos ? -1 : a[1].location.pos > b[1].location.pos ? 1 : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;

export function childrenOf(live: Live<Bookmark>): ReadonlyMap<ItemId, readonly ItemId[]> {
  const grouped = new Map<ItemId, [ItemId, Bookmark][]>();
  for (const pair of live) {
    const parent = pair[1].location.parent;
    const siblings = grouped.get(parent);
    if (siblings === undefined) grouped.set(parent, [pair]);
    else siblings.push(pair);
  }
  const out = new Map<ItemId, readonly ItemId[]>();
  for (const [parent, pairs] of grouped) out.set(parent, pairs.sort(byPosition).map(([id]) => id));
  return out;
}

// ---------- The type ----------

function parseLocation(raw: unknown): Location | null {
  if (typeof raw !== 'object' || raw === null || !('parent' in raw) || !('pos' in raw)) return null;
  const { parent, pos } = raw;
  if (typeof parent !== 'string' || typeof pos !== 'string' || !isItemId(parent) || !isPosition(pos)) return null;
  return { parent, pos };
}

const contentKey = (parent: ItemId, b: Bookmark) => `${parent}|${b.kind}|${b.title}|${b.kind === 'url' ? b.url : ''}`;

function adopt(input: AdoptInput<Bookmark>): Adoption<Bookmark> {
  const candidates = new Map<string, ItemId[]>();
  for (const [id, b] of [...input.unclaimed].sort(byPosition)) {
    const key = contentKey(b.location.parent, b);
    const list = candidates.get(key);
    if (list === undefined) candidates.set(key, [id]);
    else list.push(id);
  }
  const aliases = new Map<ItemId, ItemId>();
  const mapped = (id: ItemId) => aliases.get(id) ?? id;
  const kids = childrenOf(input.local);
  const visit = (id: ItemId) => {
    const b = input.local.get(id);
    if (b === undefined) return;
    if (!input.isKnown(id)) {
      const list = candidates.get(contentKey(mapped(b.location.parent), b)) ?? [];
      const target = list.find((c) => !input.local.has(c));
      if (target !== undefined) {
        aliases.set(id, target);
        list.splice(list.indexOf(target), 1);
      }
    }
    for (const child of kids.get(id) ?? []) visit(child);
  };
  for (const rootId of ROOT_IDS) for (const child of kids.get(rootId) ?? []) visit(child);
  const remapped = new Map<ItemId, Bookmark>();
  for (const [id, b] of input.local) remapped.set(mapped(id), { ...b, location: { ...b.location, parent: mapped(b.location.parent) } });
  // Matched items take their synced positions where the local order agrees; new items are minted between them.
  const placed = placeChildren(childrenOf(remapped), input.synced);
  const live = new Map<ItemId, Bookmark>();
  for (const [id, b] of remapped) live.set(id, { ...b, location: placed.get(id) ?? b.location });
  return { live, aliases };
}

function normalize(live: Live<Bookmark>, dead: Live<Bookmark>): Live<Bookmark> {
  const out = new Map(live);
  const rehome = (id: ItemId, parent: ItemId) => {
    const b = out.get(id);
    if (b !== undefined) out.set(id, { ...b, location: { ...b.location, parent } });
  };
  // 1. Break move cycles. The cycle member with the smallest ItemId goes under ROOTS.other.
  const grounded = new Set<ItemId>();
  for (const start of out.keys()) {
    const path: ItemId[] = [];
    let at: ItemId = start;
    while (!grounded.has(at) && out.has(at) && !path.includes(at)) {
      path.push(at);
      const next = out.get(at);
      if (next === undefined) break;
      at = next.location.parent;
    }
    if (path.includes(at)) {
      const cycle = path.slice(path.indexOf(at));
      rehome(cycle.reduce((min, id) => (id < min ? id : min)), ROOTS.other);
    }
    for (const id of path) grounded.add(id);
  }
  // 2. Re-home orphans under the nearest live ancestor, walking `dead` locations, else ROOTS.other.
  for (const [id, b] of out) {
    let parent = b.location.parent;
    if (out.has(parent) || isRoot(parent)) continue;
    const seen = new Set<ItemId>();
    while (!out.has(parent) && !isRoot(parent) && !seen.has(parent)) {
      seen.add(parent);
      const ancestor = dead.get(parent);
      if (ancestor === undefined) break;
      parent = ancestor.location.parent;
    }
    rehome(id, out.has(parent) || isRoot(parent) ? parent : ROOTS.other);
  }
  return out;
}

export const bookmarks: RegisterType<Bookmark> = {
  model: 'register',
  name: 'bookmarks',
  version: 1,

  parseRecord(raw) {
    const location = parseLocation(raw['location']);
    const title = raw['title'];
    if (location === null || typeof title !== 'string') return null;
    if (raw.kind === 'folder') return { kind: 'folder', title, location };
    const url = raw['url'];
    if (raw.kind === 'url' && typeof url === 'string') return { kind: 'url', title, url, location };
    return null;
  },

  adopt,
  normalize,

  references: (b) => [b.location.parent],

  label(b) {
    return b.title === '' && b.kind === 'url' ? b.url : b.title;
  },
};
