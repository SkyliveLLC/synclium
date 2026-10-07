// Full profile mode, the opt-in companion: the contract both sides share. The extension imports it for its three
// register types; the companion (companion/) imports it for the native messaging protocol and the allowlist.
// Pure: no chrome.*, no node:*. Grounded in P9 (design/grounding.md).
//
// The companion reads Helium's profile files at any time and writes them only while Helium is closed. So a
// change the extension applies is staged, not written: the companion's `read` overlays staged changes on the
// files, the extension sees its target at once, and a helper writes them after Helium quits. A staged change
// carries the value it replaces (`before`); if the file no longer holds it when the helper runs, the user changed
// it meanwhile and the staged change is dropped, so a local edit is never overwritten.
import { isItemId, type ItemId, type Json, type Live, type RegisterType } from './model.ts';

/** Native messaging host name. Lowercase, dots, and underscores only. */
export const HOST_NAME = 'computer.skylive.helium_sync';
/** Bumped on an incompatible protocol change. The extension refuses a companion with another one. */
export const PROTOCOL_VERSION = 1;
/** `meta.version` of Web Data the companion has been checked against (P9). Others are read-only refused. */
export const WEB_DATA_VERSIONS: readonly number[] = [154];

// ---------- Settings: unprotected Preferences paths ----------

/**
 * Exact paths, or prefixes ending in `.`. Only unprotected prefs (P9 Q1): a protected one written without the
 * keychain-bound hash is reset with a banner. Nothing device-specific (P9 Q6): no paths, window placement,
 * salts, timestamps, or choice-screen state.
 */
export const SETTINGS_ALLOWLIST: readonly string[] = [
  'bookmark_bar.show_on_all_tabs',
  'download.prompt_for_download',
  'intl.accept_languages',
  'spellcheck.dictionaries',
  'webkit.webprefs.default_font_size',
  'webkit.webprefs.default_fixed_font_size',
  'webkit.webprefs.minimum_font_size',
  'autofill.profile_enabled',
  'helium.browser.',
  ...['cookies', 'images', 'javascript', 'popups', 'geolocation', 'notifications', 'media_stream_mic', 'media_stream_camera', 'sound', 'automatic_downloads', 'clipboard'].map(
    (type) => `profile.default_content_setting_values.${type}`,
  ),
];

export function isSyncedSetting(path: string): boolean {
  return isItemId(path) && SETTINGS_ALLOWLIST.some((entry) => (entry.endsWith('.') ? path.startsWith(entry) && path.length > entry.length : path === entry));
}

/** One pref. The ItemId is its path. An absent pref is Chromium's default; removing the item resets it. */
export type Setting = { readonly kind: 'pref'; readonly value: Json };

// ---------- Search engines: custom rows of Web Data `keywords` ----------

/**
 * A custom engine (prepopulate_id 0, starter_pack_id 0, not created by policy). The ItemId is a sync_guid. The
 * default engine is not synced: it is protected and silently reverts on a partial write (P9 Q3).
 */
export type SearchEngine = {
  readonly kind: 'engine';
  readonly name: string;
  readonly keyword: string;
  /** With `{searchTerms}`. */
  readonly url: string;
  readonly suggestUrl: string;
  readonly faviconUrl: string;
  readonly newTabUrl: string;
  readonly imageUrl: string;
  readonly alternateUrls: readonly string[];
  readonly active: boolean;
};

// ---------- Addresses: Web Data `addresses` + `address_type_tokens` ----------

/** [token type, value, verification status], as in `address_type_tokens`. Sorted by type. */
export type AddressToken = readonly [type: number, value: string, status: number];

/** A local address. The ItemId is its guid. One register for the whole address: last writer wins on all of it. */
export type Address = { readonly kind: 'address'; readonly languageCode: string; readonly label: string; readonly tokens: readonly AddressToken[] };

// ---------- Register types ----------

const STRING_MAX = 2048;
const isText = (v: unknown): v is string => typeof v === 'string' && v.length <= STRING_MAX;
const isJson = (v: unknown): v is Json => {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(isJson);
  return typeof v === 'object' && Object.values(v).every(isJson);
};

/** Ids that equal-content records already carry, as `unclaimed` id -> local id, one each in display order. */
function adoptByContent<R extends { readonly kind: string }>(contentKey: (record: R) => string): RegisterType<R>['adopt'] {
  return ({ local, unclaimed, isKnown }) => {
    const free = new Map<string, ItemId[]>();
    for (const [id, record] of unclaimed) {
      const key = contentKey(record);
      free.set(key, [...(free.get(key) ?? []), id]);
    }
    const aliases = new Map<ItemId, ItemId>();
    const live = new Map<ItemId, R>();
    for (const [id, record] of local) {
      const match = isKnown(id) ? undefined : free.get(contentKey(record))?.shift();
      if (match === undefined) live.set(id, record);
      else {
        aliases.set(id, match);
        live.set(match, record);
      }
    }
    return { live, aliases };
  };
}

export const settings: RegisterType<Setting> = {
  model: 'register',
  name: 'settings',
  version: 1,
  parseRecord(raw) {
    const { value } = raw;
    return raw.kind === 'pref' && isJson(value) ? { kind: 'pref', value } : null;
  },
  // A path is the same setting on every device, so ids already agree. A peer file naming a path outside the
  // allowlist is dropped by `normalize` before anything applies it.
  adopt: ({ local }) => ({ live: local, aliases: new Map() }),
  normalize: (live: Live<Setting>) => new Map([...live].filter(([path]) => isSyncedSetting(path))),
  references: () => [],
  emptyReadIsSuspect: false,
  label: (setting) => JSON.stringify(setting.value).slice(0, 80),
};

export const searchEngines: RegisterType<SearchEngine> = {
  model: 'register',
  name: 'search-engines',
  version: 1,
  parseRecord(raw) {
    const { name, keyword, url, suggestUrl, faviconUrl, newTabUrl, imageUrl, alternateUrls, active } = raw;
    if (raw.kind !== 'engine' || !isText(name) || !isText(keyword) || keyword === '' || !isText(url) || !url.includes('{searchTerms}')) return null;
    if (!isText(suggestUrl) || !isText(faviconUrl) || !isText(newTabUrl) || !isText(imageUrl) || typeof active !== 'boolean') return null;
    if (!Array.isArray(alternateUrls) || !alternateUrls.every(isText)) return null;
    return { kind: 'engine', name, keyword, url, suggestUrl, faviconUrl, newTabUrl, imageUrl, alternateUrls, active };
  },
  adopt: adoptByContent((engine) => `${engine.keyword}\u0000${engine.url}`),
  /** Chromium needs keywords unique among custom engines; the lowest id keeps a contested one. */
  normalize(live) {
    const byKeyword = new Map<string, ItemId>();
    for (const [id, engine] of live) {
      const held = byKeyword.get(engine.keyword);
      if (held === undefined || id < held) byKeyword.set(engine.keyword, id);
    }
    return new Map([...live].filter(([id, engine]) => byKeyword.get(engine.keyword) === id));
  },
  references: () => [],
  emptyReadIsSuspect: false,
  label: (engine) => `${engine.name} (${engine.keyword})`,
};

const isToken = (v: unknown): v is AddressToken =>
  Array.isArray(v) && v.length === 3 && Number.isInteger(v[0]) && isText(v[1]) && Number.isInteger(v[2]);

export const addresses: RegisterType<Address> = {
  model: 'register',
  name: 'addresses',
  version: 1,
  parseRecord(raw) {
    const { languageCode, label, tokens } = raw;
    if (raw.kind !== 'address' || !isText(languageCode) || !isText(label) || !Array.isArray(tokens) || !tokens.every(isToken)) return null;
    return { kind: 'address', languageCode, label, tokens: [...tokens].sort((a, b) => a[0] - b[0]) };
  },
  adopt: adoptByContent((address) => JSON.stringify(address.tokens.filter(([, value]) => value !== '').map(([type, value]) => [type, value]))),
  normalize: (live) => live,
  references: () => [],
  emptyReadIsSuspect: false,
  label: (address) => address.label || address.tokens.find(([, value]) => value !== '')?.[1] || 'address',
};

// ---------- Native messaging protocol (extension <-> companion) ----------

export type ProfileTypeName = 'settings' | 'search-engines' | 'addresses';
export type RecordOf = { readonly settings: Setting; readonly 'search-engines': SearchEngine; readonly addresses: Address };
export type Rows<R> = readonly (readonly [ItemId, R])[];

/** What the profile holds, staged changes overlaid. Rows carry synced ids: the companion keeps the local ↔ synced id aliases. */
export type ProfileState = { readonly [T in ProfileTypeName]: Rows<RecordOf[T]> };

/** One staged change. `before` is the value the extension saw (null: absent); `after` null removes the item. */
export type StagedChange<R> = { readonly id: ItemId; readonly before: R | null; readonly after: R | null };
export type StagedChanges = { readonly [T in ProfileTypeName]: readonly StagedChange<RecordOf[T]>[] };

export type HelloReply = {
  readonly kind: 'hello';
  readonly protocol: number;
  readonly version: string;
  readonly userDataDir: string;
  /** From Local State `profile.info_cache`: directory name ("Default", "Profile 1") and the name Helium shows. */
  readonly profiles: readonly { readonly dir: string; readonly name: string }[];
};

/**
 * One request per message, answered in order. Messages from the host are capped at 1 MB by Chromium, which the
 * three types stay far below.
 */
export type HostProtocol = {
  hello: { req: Record<never, never>; res: HelloReply };
  /** `schema: 'unsupported'` when Web Data's version is not in WEB_DATA_VERSIONS: settings still read, rows do not. */
  read: { req: { readonly profile: string }; res: { readonly kind: 'state'; readonly state: ProfileState; readonly webData: 'ok' | 'unsupported'; readonly pending: number } };
  /** Local id `from` is synced id `to` from now on (adoption). Engines and addresses only; settings ids are paths. */
  bind: { req: { readonly profile: string; readonly type: Exclude<ProfileTypeName, 'settings'>; readonly aliases: readonly (readonly [ItemId, ItemId])[] }; res: { readonly kind: 'ok'; readonly pending: number } };
  /** Queue changes and make sure the apply helper waits for Helium to quit. Later changes to one id replace earlier ones, keeping the first `before`. */
  stage: { req: { readonly profile: string; readonly changes: StagedChanges }; res: { readonly kind: 'ok'; readonly pending: number } };
};
export type HostRequest = { [K in keyof HostProtocol]: { readonly kind: K } & HostProtocol[K]['req'] }[keyof HostProtocol];
export type HostReply<K extends keyof HostProtocol> = HostProtocol[K]['res'] | { readonly kind: 'error'; readonly message: string };
