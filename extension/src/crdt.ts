// The generic register layer, written once for every replica type (p3 variant B).
// Pure and deterministic in its arguments. That determinism is what makes a sync crash-convergent.
import { isDeviceId, isHlc, type DeviceId, type Entry, type Hlc, type HlcState, type ItemId, type Live, type Rec, type Reg, type Replica } from './model.ts';

const WALL_WIDTH = 9;
const COUNTER_WIDTH = 4;

function parseHlc(h: Hlc): { readonly wall: number; readonly counter: number; readonly author: DeviceId } {
  const [wall, counter, author] = h.split('.');
  if (wall === undefined || counter === undefined || author === undefined || !isDeviceId(author)) throw new Error(`bad hlc ${h}`);
  return { wall: parseInt(wall, 36), counter: parseInt(counter, 36), author };
}

export const hlcAuthor = (h: Hlc): DeviceId => parseHlc(h).author;

/** Next stamp, strictly greater than `prev` and every stamp seen in the store. One stamp per type per cycle. */
export function tick(prev: HlcState, nowMs: number, newestSeen: Hlc | null, self: DeviceId): { state: HlcState; stamp: Hlc } {
  const seen = newestSeen === null ? { wall: -1, counter: -1 } : parseHlc(newestSeen);
  const wall = Math.max(prev.wall, nowMs, seen.wall);
  const counter =
    wall > prev.wall && wall > seen.wall
      ? 0
      : 1 + Math.max(wall === prev.wall ? prev.counter : -1, wall === seen.wall ? seen.counter : -1);
  const stamp = `${wall.toString(36).padStart(WALL_WIDTH, '0')}.${counter.toString(36).padStart(COUNTER_WIDTH, '0')}.${self}`;
  if (!isHlc(stamp)) throw new Error(`clock out of range: ${stamp}`);
  return { state: { wall, counter }, stamp };
}

// ---------- Structural view of an entry ----------
//
// `Entry<R>` distributes over the record union, so the compiler cannot relate a value of type `R` to its
// mapped `Entry<R>` for a generic `R`. These two helpers are the only place that relation is asserted; every
// other function works on the structural view, which `Entry<R>` is assignable to.

type View = {
  readonly kind: string;
  readonly fields: { readonly [field: string]: Reg<unknown> };
  readonly deleted: Reg<boolean>;
};

/** A record as an entry whose registers all carry `stamp`. */
export function entryOf<R extends Rec>(record: R, stamp: Hlc): Entry<R> {
  return entryWith(record, () => stamp, [false, stamp]);
}

/** A record as an entry with one stamp per register (the parse boundary). */
export function entryWith<R extends Rec>(record: R, stampOf: (field: string) => Hlc, deleted: Reg<boolean>): Entry<R> {
  return viewToEntry({ kind: record.kind, fields: regsOf(record, stampOf), deleted });
}

function regsOf(record: Rec, stampOf: (field: string) => Hlc): View['fields'] {
  const fields: { [field: string]: Reg<unknown> } = {};
  for (const [field, value] of Object.entries(record)) if (field !== 'kind') fields[field] = [value, stampOf(field)];
  return fields;
}

function viewToEntry<R extends Rec>(view: View): Entry<R> {
  // Invariant held by every caller: `view.fields` has exactly the non-kind keys of an `R` with `view.kind`.
  return view as Entry<R>;
}

/** The plain record inside an entry. */
export function recordOf<R extends Rec>(entry: Entry<R>): R {
  const view: View = entry;
  const record: { [field: string]: unknown } = { kind: view.kind };
  for (const [field, [value]] of Object.entries(view.fields)) record[field] = value;
  // Inverse of `viewToEntry`: the fields of an `Entry<R>` are exactly the non-kind fields of its `R`.
  return record as R;
}

/** The newest stamp among an entry's registers. */
function newestOf(view: View): Hlc {
  let newest = view.deleted[1];
  for (const [, stamp] of Object.values(view.fields)) if (stamp > newest) newest = stamp;
  return newest;
}

export function newestStamp(replicas: Iterable<Replica<Rec>>): Hlc | null {
  let newest: Hlc | null = null;
  for (const replica of replicas)
    for (const entry of replica.values()) {
      const stamp = newestOf(entry);
      if (newest === null || stamp > newest) newest = stamp;
    }
  return newest;
}

const maxReg = <T>(a: Reg<T> | undefined, b: Reg<T>): Reg<T> => (a === undefined || b[1] > a[1] ? b : a);

/** Entries with the same kind merge per register. A kind clash (never minted, but a peer file could carry one) keeps the newer entry. */
function mergeEntries(a: View, b: View): View {
  if (a.kind !== b.kind) return newestOf(b) > newestOf(a) ? b : a;
  const fields: { [field: string]: Reg<unknown> } = { ...a.fields };
  for (const [field, reg] of Object.entries(b.fields)) fields[field] = maxReg(fields[field], reg);
  return { kind: a.kind, fields, deleted: maxReg(a.deleted, b.deleted) };
}

/** Per register, the higher stamp wins. Commutative, associative, idempotent. */
export function mergeReplicas<R extends Rec>(replicas: readonly Replica<R>[]): Replica<R> {
  const out = new Map<ItemId, Entry<R>>();
  for (const replica of replicas)
    for (const [id, entry] of replica) {
      const current = out.get(id);
      out.set(id, current === undefined ? entry : viewToEntry(mergeEntries(current, entry)));
    }
  return out;
}

const isRecord = (v: unknown): v is { readonly [k: string]: unknown } => typeof v === 'object' && v !== null && !Array.isArray(v);

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

export const sameLive = <R extends Rec>(a: Live<R>, b: Live<R>): boolean =>
  a.size === b.size && [...a].every(([id, record]) => b.has(id) && deepEqual(record, b.get(id)));

/**
 * Fold this device's profile edits into the merged replica.
 *
 * A field gets `stamp` only when `observed != applied` AND `observed != merged`. The second condition is
 * what keeps a half-applied or deferred apply from re-stamping a remote value as a fresh local edit.
 * An id in `applied` but absent from `observed` gets deleted=[true, stamp] unless `merged` already says so.
 * An id in `merged` but not in `applied` keeps the merged values: the profile holds it through adoption or a
 * killed apply, never through an edit, so its local position is not a move.
 * An id `merged` has deleted keeps its tombstone untouched: delete beats concurrent edit, so a local field
 * change on it (often a position re-minted while siblings moved) is moot.
 * An id in neither `applied` nor `merged` becomes a new entry.
 * `applied === null` is a first join. New items are added, matched items keep the merged values, and nothing is deleted.
 */
export function foldLocalChanges<R extends Rec>(merged: Replica<R>, applied: Live<R> | null, observed: Live<R>, stamp: Hlc): Replica<R> {
  const out = new Map<ItemId, Entry<R>>(merged);
  for (const [id, record] of observed) {
    const current = merged.get(id);
    if (current === undefined) {
      out.set(id, entryOf(record, stamp));
      continue;
    }
    const before = applied?.get(id);
    if (before === undefined || current.deleted[0]) continue;
    const view: View = current;
    const fields: { [field: string]: Reg<unknown> } = { ...view.fields };
    for (const [field, value] of Object.entries(record)) {
      if (field === 'kind') continue;
      const reg = view.fields[field];
      if (reg === undefined || (!deepEqual(value, fieldOf(before, field)) && !deepEqual(value, reg[0]))) fields[field] = [value, stamp];
    }
    out.set(id, viewToEntry({ kind: view.kind, fields, deleted: view.deleted }));
  }
  if (applied !== null)
    for (const id of applied.keys()) {
      const current = out.get(id);
      if (observed.has(id) || current === undefined || current.deleted[0]) continue;
      const view: View = current;
      out.set(id, viewToEntry({ ...view, deleted: [true, stamp] }));
    }
  return out;
}

function fieldOf(record: Rec, field: string): unknown {
  const r: { readonly [k: string]: unknown } = record;
  return r[field];
}

/** Drop tombstones, then let the type repair cross-item invariants with the dead records as history. */
export function materialize<R extends Rec>(replica: Replica<R>, normalize: (live: Live<R>, dead: Live<R>) => Live<R>): Live<R> {
  const live = new Map<ItemId, R>();
  const dead = new Map<ItemId, R>();
  for (const [id, entry] of replica) (entry.deleted[0] ? dead : live).set(id, recordOf(entry));
  return normalize(live, dead);
}

/**
 * Per author, the newest stamp of that author this device has merged. Published in every state file.
 * This is sound because state files are full state. Holding author A's stamp s2 implies holding every earlier A stamp.
 */
export type Acked = ReadonlyMap<DeviceId, Hlc>;

/** Never lower than `previous`, because GC may remove the stamp that set the high-water mark. */
export function ackedOf<R extends Rec>(replica: Replica<R>, previous: Acked): Acked {
  const acked = new Map(previous);
  const see = (stamp: Hlc) => {
    const author = hlcAuthor(stamp);
    const held = acked.get(author);
    if (held === undefined || stamp > held) acked.set(author, stamp);
  };
  for (const entry of replica.values()) {
    const view: View = entry;
    see(view.deleted[1]);
    for (const [, stamp] of Object.values(view.fields)) see(stamp);
  }
  return acked;
}

/**
 * Drop a tombstone stamped `s` by author `a` once every live device's Acked holds `a` at `s` or later, unless
 * a live record still reaches it through `references` (then `normalize` still needs it).
 * Idle devices are not in `acks`. They are also excluded from merge, so they cannot resurrect what GC dropped.
 */
export function collectGarbage<R extends Rec>(merged: Replica<R>, acks: readonly Acked[], references: (record: R) => readonly ItemId[]): Replica<R> {
  const pinned = referencedTombstones(merged, references);
  const out = new Map<ItemId, Entry<R>>();
  for (const [id, entry] of merged) {
    const [deleted, stamp] = entry.deleted;
    if (deleted && !pinned.has(id)) {
      const author = hlcAuthor(stamp);
      if (acks.every((ack) => (ack.get(author) ?? '') >= stamp)) continue;
    }
    out.set(id, entry);
  }
  return out;
}

/** Tombstones reachable from a live record by following `references` through other tombstones. */
function referencedTombstones<R extends Rec>(replica: Replica<R>, references: (record: R) => readonly ItemId[]): ReadonlySet<ItemId> {
  const pinned = new Set<ItemId>();
  const queue: ItemId[] = [];
  for (const entry of replica.values()) if (!entry.deleted[0]) queue.push(...references(recordOf(entry)));
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    const entry = replica.get(id);
    if (entry === undefined || !entry.deleted[0] || pinned.has(id)) continue;
    pinned.add(id);
    queue.push(...references(recordOf(entry)));
  }
  return pinned;
}

export type Change<R extends Rec> =
  | { readonly op: 'add'; readonly id: ItemId; readonly after: R }
  | { readonly op: 'update'; readonly id: ItemId; readonly before: R; readonly after: R }
  | { readonly op: 'remove'; readonly id: ItemId; readonly before: R };

export function diffLive<R extends Rec>(from: Live<R>, to: Live<R>): readonly Change<R>[] {
  const changes: Change<R>[] = [];
  for (const [id, after] of to) {
    const before = from.get(id);
    if (before === undefined) changes.push({ op: 'add', id, after });
    else if (!deepEqual(before, after)) changes.push({ op: 'update', id, before, after });
  }
  for (const [id, before] of from) if (!to.has(id)) changes.push({ op: 'remove', id, before });
  return changes;
}

/**
 * Mass-delete guard. Non-null when the read looks like the wrong profile or a file caught mid-write
 * (empty while `applied` was not, or more than `fraction` of at least `minItems` items gone).
 */
export function massDelete<R extends Rec>(
  applied: Live<R> | null,
  observed: Live<R>,
  limits: { readonly minItems: number; readonly fraction: number },
): { readonly removed: number; readonly of: number } | null {
  if (applied === null || applied.size === 0) return null;
  let removed = 0;
  for (const id of applied.keys()) if (!observed.has(id)) removed++;
  const of = applied.size;
  if (observed.size === 0 || (of >= limits.minItems && removed / of > limits.fraction)) return { removed, of };
  return null;
}
