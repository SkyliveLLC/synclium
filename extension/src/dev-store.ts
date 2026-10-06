// DEVELOPMENT ONLY. A Store over chrome.storage.local, so one browser can run a full cycle without picking a
// folder. Compiled only by `npm run build:dev` into dist-dev/; the release build excludes this file and fails if
// it shows up in dist/ (scripts/build.mjs). Nothing here leaves the browser profile, so it is not sync.
//
// Each key is `store:<StoreKey>` holding { b64, version }; version counts puts, which is what `get(key, known)`
// compares, as a folder compares lastModified + size.
import type { Fetched, ProbeResult, Store, StoreConnection } from './ports.ts';
import type { StoreBackend } from './background.ts';

const PREFIX = 'store:';
const PROBE = `${PREFIX}.helium-sync-probe`;

type Row = { readonly b64: string; readonly version: number };

const isRow = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && 'b64' in value && typeof value.b64 === 'string' && 'version' in value && typeof value.version === 'number';

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
const fromBase64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

async function row(key: string): Promise<Row | null> {
  const value: unknown = (await chrome.storage.local.get(key))[key];
  return isRow(value) ? value : null;
}

const storageStore: Store = {
  async list(prefix) {
    const names = new Set<string>();
    for (const key of await chrome.storage.local.getKeys()) {
      if (!key.startsWith(PREFIX + prefix)) continue;
      const rest = key.slice(PREFIX.length + prefix.length);
      const slash = rest.indexOf('/');
      names.add(slash < 0 ? rest : rest.slice(0, slash));
    }
    return [...names].sort();
  },
  async get(key, known): Promise<Fetched> {
    const held = await row(PREFIX + key);
    if (held === null) return { kind: 'missing' };
    const version = String(held.version);
    return version === known ? { kind: 'unchanged' } : { kind: 'ok', bytes: fromBase64(held.b64), version };
  },
  async put(key, bytes) {
    const version = ((await row(PREFIX + key))?.version ?? 0) + 1;
    await chrome.storage.local.set({ [PREFIX + key]: { b64: toBase64(bytes), version } satisfies Row });
  },
  async delete(key) {
    await chrome.storage.local.remove(PREFIX + key);
  },
  async probe(): Promise<ProbeResult> {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    await chrome.storage.local.set({ [PROBE]: { b64: toBase64(bytes), version: 1 } satisfies Row });
    const back = await row(PROBE);
    await chrome.storage.local.remove(PROBE);
    return back?.b64 === toBase64(bytes) ? { kind: 'ok' } : { kind: 'failed', why: { kind: 'rejected', detail: 'probe read back different bytes' } };
  },
};

const ready: StoreConnection = { access: 'ready', label: 'Development store (this browser only)', store: storageStore };

/** Both slots are the one store, and there is nothing to promote. */
export const devStoreBackend: StoreBackend = {
  connect: async () => ready,
  promote: async () => {},
};
