// Installed extensions as a snapshot type: each device publishes its own list, and the others offer what they
// lack. Nothing is installed for the user. Extensions cannot install extensions (P8), so "Add" opens the
// Chrome Web Store page and the user clicks there.
import type { SnapshotType } from './model.ts';

/** `store`: installed from the Chrome Web Store, so its id opens its store page. `unpacked`: Load unpacked. */
export type ExtensionSource = 'store' | 'unpacked' | 'other';

export type ExtensionInfo = { readonly id: string; readonly name: string; readonly enabled: boolean; readonly source: ExtensionSource };

/** Sorted by id, so an unchanged set hashes the same and is not republished. */
export type ExtensionList = readonly ExtensionInfo[];

const EXTENSION_ID = /^[a-p]{32}$/;
const NAME_MAX = 128;
const SOURCES: readonly ExtensionSource[] = ['store', 'unpacked', 'other'];
const isSource = (s: unknown): s is ExtensionSource => SOURCES.some((source) => source === s);

export const extensions: SnapshotType<ExtensionList> = {
  model: 'snapshot',
  name: 'extensions',
  version: 1,
  parseContent(raw) {
    if (!Array.isArray(raw)) return null;
    const list: ExtensionInfo[] = [];
    for (const item of raw) {
      if (typeof item !== 'object' || item === null || !('id' in item) || !('name' in item) || !('enabled' in item) || !('source' in item)) continue;
      const { id, name, enabled, source } = item;
      if (typeof id === 'string' && EXTENSION_ID.test(id) && typeof name === 'string' && typeof enabled === 'boolean' && isSource(source))
        list.push({ id, name: name.slice(0, NAME_MAX), enabled, source });
    }
    return list;
  },
};

export const storePage = (id: string): string => `https://chromewebstore.google.com/detail/${id}`;

/** One extension some other device has and this one lacks. `on` names the devices, in the order given. */
export type Offer = { readonly id: string; readonly name: string; readonly source: ExtensionSource; readonly on: readonly string[] };

/** What peers have that `here` lacks, by name. A store install anywhere makes the offer addable. */
export function offers(peers: readonly { readonly name: string; readonly extensions: ExtensionList }[], here: ReadonlySet<string>): readonly Offer[] {
  const byId = new Map<string, { name: string; source: ExtensionSource; on: string[] }>();
  for (const peer of peers)
    for (const ext of peer.extensions) {
      if (here.has(ext.id)) continue;
      const held = byId.get(ext.id);
      if (held === undefined) byId.set(ext.id, { name: ext.name, source: ext.source, on: [peer.name] });
      else {
        held.on.push(peer.name);
        if (ext.source === 'store') held.source = 'store';
      }
    }
  return [...byId].map(([id, offer]) => ({ id, ...offer })).sort((a, b) => a.name.localeCompare(b.name));
}
