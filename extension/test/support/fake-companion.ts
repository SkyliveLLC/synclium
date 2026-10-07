// The companion in memory, for one profile. A staged change lands at once: the real companion overlays it on
// every read until Helium quits, so to the extension the two look the same. Rows are kept by local id, and
// `bind` aliases them to synced ids the way the companion's alias map does.
import { isItemId, type ItemId } from '../../src/model.ts';
import type { CompanionLink } from '../../src/chrome-profile.ts';
import { PROTOCOL_VERSION, type Address, type HelloReply, type HostProtocol, type SearchEngine, type Setting, type StagedChange } from '../../src/profile-mode.ts';

/** An ItemId from a literal, for pref paths and guids in tests. */
export function itemId(s: string): ItemId {
  if (!isItemId(s)) throw new Error(`not an ItemId: ${s}`);
  return s;
}

/** Rows by local id, shown under their synced ids. */
class Table<R> {
  readonly rows = new Map<ItemId, R>();
  readonly aliases = new Map<ItemId, ItemId>();

  synced(): (readonly [ItemId, R])[] {
    return [...this.rows].map(([id, row]) => [this.aliases.get(id) ?? id, row] as const);
  }

  stage(changes: readonly StagedChange<R>[]): void {
    for (const { id, after } of changes) {
      const local = [...this.aliases].find(([, synced]) => synced === id)?.[0] ?? id;
      if (after === null) this.rows.delete(local);
      else this.rows.set(local, after);
    }
  }
}

export class FakeCompanion implements CompanionLink {
  readonly settings = new Table<Setting>();
  readonly engines = new Table<SearchEngine>();
  readonly addresses = new Table<Address>();
  readonly binds: HostProtocol['bind']['req'][] = [];
  webData: 'ok' | 'unsupported' = 'ok';
  /** Staged changes Helium has not quit for yet. Nothing here quits, so it only grows. */
  pending = 0;

  async hello(): Promise<HelloReply> {
    return { kind: 'hello', protocol: PROTOCOL_VERSION, version: '0.0.0-test', userDataDir: '/fake', profiles: [{ dir: 'Default', name: 'Person 1' }] };
  }

  async read(): Promise<HostProtocol['read']['res']> {
    const rows = this.webData === 'ok';
    return {
      kind: 'state',
      state: { settings: this.settings.synced(), 'search-engines': rows ? this.engines.synced() : [], addresses: rows ? this.addresses.synced() : [] },
      webData: this.webData,
      pending: this.pending,
    };
  }

  async bind(req: HostProtocol['bind']['req']): Promise<HostProtocol['bind']['res']> {
    this.binds.push(req);
    const table = req.type === 'search-engines' ? this.engines : this.addresses;
    for (const [from, to] of req.aliases) table.aliases.set(from, to);
    return { kind: 'ok', pending: this.pending };
  }

  async stage({ changes }: HostProtocol['stage']['req']): Promise<HostProtocol['stage']['res']> {
    this.settings.stage(changes.settings);
    this.engines.stage(changes['search-engines']);
    this.addresses.stage(changes.addresses);
    this.pending += changes.settings.length + changes['search-engines'].length + changes.addresses.length;
    return { kind: 'ok', pending: this.pending };
  }
}
