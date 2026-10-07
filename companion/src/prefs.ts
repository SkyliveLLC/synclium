// The settings register over a profile's `Preferences` JSON. Reads and writes only allowlisted paths; every other
// key passes through untouched. `Secure Preferences` is read for the default engine's guid and never written.
import { isSyncedSetting, SETTINGS_ALLOWLIST, type Setting } from '../../extension/src/profile-mode.ts';
import { isItemId, type ItemId, type Json } from '../../extension/src/model.ts';
import { isRecord, valueAt, type JsonRecord } from './json.ts';

/** Leaf paths under `prefix` (arrays count as leaves). */
function* leaves(value: Json, prefix: string): Generator<readonly [string, Json]> {
  if (!isRecord(value)) {
    yield [prefix, value];
    return;
  }
  for (const [key, child] of Object.entries(value)) yield* leaves(child, `${prefix}.${key}`);
}

/** Every allowlisted pref present in `prefs`. An exact entry may hold any JSON; a prefix entry yields each leaf under it. */
export function readSettings(prefs: JsonRecord): Map<ItemId, Setting> {
  const settings = new Map<ItemId, Setting>();
  for (const entry of SETTINGS_ALLOWLIST) {
    const exact = !entry.endsWith('.');
    const root = valueAt(prefs, exact ? entry : entry.slice(0, -1));
    if (root === undefined || (!exact && !isRecord(root))) continue;
    for (const [path, value] of exact ? [[entry, root] as const] : leaves(root, entry.slice(0, -1))) {
      if (isItemId(path) && isSyncedSetting(path)) settings.set(path, { kind: 'pref', value });
    }
  }
  return settings;
}

/**
 * `prefs` with the pref at `path` set to `value`, or removed when `value` is undefined (Chromium then uses its
 * default). Null when the write would clobber structure: a non-object on the way down, or a dict that only an
 * exact allowlist entry may replace.
 */
export function withSetting(prefs: JsonRecord, path: ItemId, value: Json | undefined): JsonRecord | null {
  if (!isSyncedSetting(path)) return null;
  const replaceable = (current: Json | undefined) => !isRecord(current) || SETTINGS_ALLOWLIST.includes(path);
  const put = (node: JsonRecord, keys: readonly string[]): JsonRecord | null => {
    const [key, ...rest] = keys;
    if (key === undefined) return null;
    const current = node[key];
    if (rest.length === 0) {
      if (!replaceable(current)) return null;
      if (value !== undefined) return { ...node, [key]: value };
      const { [key]: _removed, ...kept } = node;
      return kept;
    }
    if (current === undefined) return value === undefined ? node : { ...node, [key]: build(rest) };
    if (!isRecord(current)) return null;
    const child = put(current, rest);
    return child === null ? null : { ...node, [key]: child };
  };
  const build = (keys: readonly string[]): Json => keys.reduceRight<Json>((inner, key) => ({ [key]: inner }), value ?? null);
  return put(prefs, path.split('.'));
}

const guidAt = (root: JsonRecord, path: string): string[] => {
  const guid = valueAt(root, path);
  return typeof guid === 'string' && guid !== '' ? [guid] : [];
};

/**
 * Every guid that names the default search engine. Protected (P9 Q3): writing its row without re-signing the
 * hashes makes Helium silently drop it, so the engine register never reads or writes it.
 */
export function defaultEngineGuids(prefs: JsonRecord, securePrefs: JsonRecord): Set<string> {
  return new Set([
    ...guidAt(prefs, 'default_search_provider.guid'),
    ...guidAt(prefs, 'default_search_provider_data.mirrored_template_url_data.synced_guid'),
    ...guidAt(securePrefs, 'default_search_provider_data.template_url_data.synced_guid'),
  ]);
}
