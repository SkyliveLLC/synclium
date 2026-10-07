// The companion's own state, one file per (user data dir, profile): the local -> synced id aliases `bind` fills, and
// the changes `stage` queued for the apply helper. Plus the pure rules over them: alias mapping, the stage merge,
// and the overlay `read` presents.
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { addresses, isSyncedSetting, searchEngines, settings, type ProfileTypeName, type StagedChange, type StagedChanges } from '../../extension/src/profile-mode.ts';
import { isItemId, type ItemId, type Rec, type RegisterType } from '../../extension/src/model.ts';
import { isRecord, parseJsonRecord, writeFileAtomic } from './json.ts';
import { keyOf } from './paths.ts';

export type AliasType = Exclude<ProfileTypeName, 'settings'>;
/** local id -> synced id, per type. */
export type Aliases = { readonly [T in AliasType]: ReadonlyMap<ItemId, ItemId> };

export type ProfileStore = {
  readonly userDataDir: string;
  readonly profile: string;
  readonly aliases: Aliases;
  readonly pending: StagedChanges;
};

export const TYPE_NAMES = ['settings', 'search-engines', 'addresses'] as const satisfies readonly ProfileTypeName[];
const ALIAS_TYPES = ['search-engines', 'addresses'] as const satisfies readonly AliasType[];

export const emptyStore = (userDataDir: string, profile: string): ProfileStore => ({
  userDataDir,
  profile,
  aliases: { 'search-engines': new Map(), addresses: new Map() },
  pending: { settings: [], 'search-engines': [], addresses: [] },
});

export const pendingCount = (pending: StagedChanges): number => TYPE_NAMES.reduce((sum, type) => sum + pending[type].length, 0);

// ---------- Pure rules ----------

/** Rows keyed by local id, re-keyed by synced id. */
export function toSynced<R>(local: ReadonlyMap<ItemId, R>, aliases: ReadonlyMap<ItemId, ItemId>): Map<ItemId, R> {
  return new Map([...local].map(([id, record]) => [aliases.get(id) ?? id, record]));
}

/** The local id a synced id is stored under: its aliased row, or itself (a row the companion inserted, or never adopted). */
export function localIdOf(synced: ItemId, aliases: ReadonlyMap<ItemId, ItemId>): ItemId {
  for (const [local, to] of aliases) if (to === synced) return local;
  return synced;
}

/** One synced id per local id and one local id per synced id: a later bind replaces both sides. */
export function withAliases(aliases: ReadonlyMap<ItemId, ItemId>, added: readonly (readonly [ItemId, ItemId])[]): Map<ItemId, ItemId> {
  const next = new Map(aliases);
  for (const [from, to] of added) {
    for (const [local, synced] of next) if (synced === to) next.delete(local);
    next.set(from, to);
  }
  return next;
}

/** True when the file still holds what the change replaces (null: absent). */
export const stillHolds = <R>(current: ReadonlyMap<ItemId, R>, change: StagedChange<R>): boolean => isDeepStrictEqual(current.get(change.id) ?? null, change.before);

/** What `read` shows: each staged change whose `before` the file still holds, applied; the rest as the file has them. */
export function overlay<R>(current: ReadonlyMap<ItemId, R>, pending: readonly StagedChange<R>[]): Map<ItemId, R> {
  const view = new Map(current);
  for (const change of pending) {
    if (!stillHolds(current, change)) continue;
    if (change.after === null) view.delete(change.id);
    else view.set(change.id, change.after);
  }
  return view;
}

/** Per id: the first `before` stays, the latest `after` wins, and a change that lands back on `before` is dropped. */
export function mergeStaged<R>(pending: readonly StagedChange<R>[], incoming: readonly StagedChange<R>[]): StagedChange<R>[] {
  const byId = new Map(pending.map((change) => [change.id, change]));
  for (const { id, before, after } of incoming) {
    const prior = byId.get(id);
    const first = prior === undefined ? before : prior.before;
    if (isDeepStrictEqual(first, after)) byId.delete(id);
    else byId.set(id, { id, before: first, after });
  }
  return [...byId.values()];
}

/** `pending` minus the changes the helper handled, unless `stage` replaced one meanwhile. */
export function withoutHandled<R>(pending: readonly StagedChange<R>[], handled: readonly StagedChange<R>[]): StagedChange<R>[] {
  return pending.filter((change) => !handled.some((done) => isDeepStrictEqual(done, change)));
}

// ---------- Parsing (the wire and the state file) ----------

function parseChange<R extends Rec>(type: RegisterType<R>, raw: unknown): StagedChange<R> | null {
  if (!isRecord(raw)) return null;
  const { id, before, after } = raw;
  if (typeof id !== 'string' || !isItemId(id) || (type.name === 'settings' && !isSyncedSetting(id))) return null;
  // undefined: present but invalid, which rejects the change.
  const record = (value: unknown): R | null | undefined =>
    value === null ? null : isRecord(value) ? (type.parseRecord({ ...value, kind: value['kind'] }) ?? undefined) : undefined;
  const parsedBefore = record(before);
  const parsedAfter = record(after);
  return parsedBefore === undefined || parsedAfter === undefined ? null : { id, before: parsedBefore, after: parsedAfter };
}

/** Every change must parse: a stage request is all or nothing. */
function parseChangeList<R extends Rec>(type: RegisterType<R>, raw: unknown): StagedChange<R>[] | null {
  if (!Array.isArray(raw)) return null;
  const changes = raw.map((item) => parseChange(type, item));
  return changes.every((change) => change !== null) ? changes : null;
}

export function parseStagedChanges(raw: unknown): StagedChanges | null {
  if (!isRecord(raw)) return null;
  const parsed = {
    settings: parseChangeList(settings, raw['settings'] ?? []),
    'search-engines': parseChangeList(searchEngines, raw['search-engines'] ?? []),
    addresses: parseChangeList(addresses, raw['addresses'] ?? []),
  };
  const { settings: s, 'search-engines': e, addresses: a } = parsed;
  return s === null || e === null || a === null ? null : { settings: s, 'search-engines': e, addresses: a };
}

export function parseAliasPairs(raw: unknown): [ItemId, ItemId][] | null {
  if (!Array.isArray(raw)) return null;
  const pairs: [ItemId, ItemId][] = [];
  for (const pair of raw) {
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    const [from, to]: unknown[] = pair;
    if (typeof from !== 'string' || typeof to !== 'string' || !isItemId(from) || !isItemId(to)) return null;
    pairs.push([from, to]);
  }
  return pairs;
}

// ---------- Persistence ----------

const stateDir = (home: string) => join(home, 'state');
const storePath = (home: string, userDataDir: string, profile: string) => join(stateDir(home), `${keyOf(userDataDir, profile)}.json`);

function parseStore(text: string, path: string): ProfileStore | null {
  const raw = parseJsonRecord(text, path);
  const { userDataDir, profile } = raw;
  const pending = parseStagedChanges(raw['pending']);
  const aliases = isRecord(raw['aliases']) ? raw['aliases'] : {};
  const engineAliases = parseAliasPairs(aliases['search-engines'] ?? []);
  const addressAliases = parseAliasPairs(aliases['addresses'] ?? []);
  if (typeof userDataDir !== 'string' || typeof profile !== 'string' || pending === null || engineAliases === null || addressAliases === null) return null;
  return { userDataDir, profile, pending, aliases: { 'search-engines': new Map(engineAliases), addresses: new Map(addressAliases) } };
}

export function loadStore(home: string, userDataDir: string, profile: string): ProfileStore {
  const path = storePath(home, userDataDir, profile);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return emptyStore(userDataDir, profile);
  }
  const store = parseStore(text, path);
  if (store === null) throw new Error(`unreadable companion state ${path}`);
  return store;
}

export function saveStore(home: string, store: ProfileStore): void {
  mkdirSync(stateDir(home), { recursive: true });
  const aliases = Object.fromEntries(ALIAS_TYPES.map((type) => [type, [...store.aliases[type]]]));
  writeFileAtomic(storePath(home, store.userDataDir, store.profile), `${JSON.stringify({ ...store, aliases }, null, 1)}\n`);
}

/** Every profile of `userDataDir` with staged changes. */
export function pendingStores(home: string, userDataDir: string): ProfileStore[] {
  let names: string[];
  try {
    names = readdirSync(stateDir(home)).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  return names
    .flatMap((name) => {
      const path = join(stateDir(home), name);
      const store = parseStore(readFileSync(path, 'utf8'), path);
      return store === null ? [] : [store];
    })
    .filter((store) => store.userDataDir === userDataDir && pendingCount(store.pending) > 0);
}
