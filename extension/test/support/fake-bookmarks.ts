// A fake chrome.bookmarks: a tree of nodes with per-profile ids and integer indexes, and a RegisterChannel over
// it that owns the chrome id -> ItemId map the way chrome-bookmarks.ts does. `api.call` stands for one
// chrome.bookmarks API call; the crash harness counts and kills there, so a node can exist before its map row.
import { isItemId, type ItemId } from '../../src/model.ts';
import { ROOTS, childrenOf, placeChildren, type Bookmark } from '../../src/bookmarks.ts';
import type { ApplyResult, Budget, RegisterChannel } from '../../src/ports.ts';
import { diffLive } from '../../src/crdt.ts';

export type ChromeNode = { readonly id: string; parentId: string; index: number; title: string; url: string | null };

const ROOT_CHROME: ReadonlyMap<string, ItemId> = new Map([
  ['1', ROOTS.bar],
  ['2', ROOTS.other],
  ['3', ROOTS.mobile],
]);

export class FakeBrowser {
  readonly nodes = new Map<string, ChromeNode>();
  #next = 10;

  constructor() {
    for (const id of ROOT_CHROME.keys()) this.nodes.set(id, { id, parentId: '0', index: 0, title: '', url: null });
  }

  children(parentId: string): ChromeNode[] {
    return [...this.nodes.values()].filter((n) => n.parentId === parentId).sort((a, b) => a.index - b.index);
  }

  #reindex(parentId: string): void {
    this.children(parentId).forEach((n, i) => (n.index = i));
  }

  add(parentId: string, index: number, node: { readonly title: string; readonly url?: string }): string {
    if (!this.nodes.has(parentId)) throw new Error(`no parent ${parentId}`);
    const id = String(this.#next++);
    for (const sibling of this.children(parentId)) if (sibling.index >= index) sibling.index++;
    this.nodes.set(id, { id, parentId, index, title: node.title, url: node.url ?? null });
    this.#reindex(parentId);
    return id;
  }

  rename(id: string, title: string): void {
    this.#node(id).title = title;
  }

  move(id: string, parentId: string, index: number): void {
    const node = this.#node(id);
    const from = node.parentId;
    node.parentId = '-';
    this.#reindex(from);
    for (const sibling of this.children(parentId)) if (sibling.index >= index) sibling.index++;
    node.parentId = parentId;
    node.index = index;
    this.#reindex(parentId);
  }

  remove(id: string): void {
    const node = this.#node(id);
    for (const child of this.children(id)) this.remove(child.id);
    this.nodes.delete(id);
    this.#reindex(node.parentId);
  }

  #node(id: string): ChromeNode {
    const node = this.nodes.get(id);
    if (node === undefined) throw new Error(`no node ${id}`);
    return node;
  }

  /** Content only: no ids, so two profiles that show the same bookmarks render alike. */
  render(): string {
    const lines: string[] = [];
    const walk = (id: string, depth: number) => {
      for (const n of this.children(id)) {
        lines.push(`${'  '.repeat(depth)}${n.url === null ? 'folder' : 'url'} ${JSON.stringify(n.title)}${n.url === null ? '' : ` ${n.url}`}`);
        walk(n.id, depth + 1);
      }
    };
    for (const [rootId] of ROOT_CHROME) {
      lines.push(`root ${rootId}`);
      walk(rootId, 1);
    }
    return lines.join('\n');
  }

  find(title: string): ChromeNode[] {
    return [...this.nodes.values()].filter((n) => n.title === title);
  }

  /** Title of the parent of the first node with `title`, or the root's chrome id. */
  parentTitleOf(title: string): string | null {
    const node = this.find(title)[0];
    if (node === undefined) return null;
    const parent = this.nodes.get(node.parentId);
    return parent === undefined ? null : ROOT_CHROME.has(parent.id) ? `root ${parent.id}` : parent.title;
  }
}

export type Api = { call(name: 'create' | 'update' | 'move' | 'remove'): Promise<void> };
const noApi: Api = { call: async () => {} };

export type FakeChannel = RegisterChannel<Bookmark> & {
  readonly browser: FakeBrowser;
  /** chrome id -> ItemId. Survives LocalState.clear, as the real id map does. */
  readonly idMap: Map<string, ItemId>;
};

export function fakeBookmarks(browser: FakeBrowser, ids: (hint: string) => ItemId, api: Api = noApi): FakeChannel {
  const idMap = new Map<string, ItemId>();
  const itemOf = (chromeId: string): ItemId => {
    const root = ROOT_CHROME.get(chromeId);
    if (root !== undefined) return root;
    let item = idMap.get(chromeId);
    if (item === undefined) idMap.set(chromeId, (item = ids(browser.nodes.get(chromeId)?.title ?? '')));
    return item;
  };
  const chromeOf = (item: ItemId): string => {
    for (const [chromeId, root] of ROOT_CHROME) if (root === item) return chromeId;
    for (const [chromeId, mapped] of idMap) if (mapped === item) return chromeId;
    throw new Error(`no node for ${item}`);
  };

  return {
    browser,
    idMap,

    async read(previous) {
      const children = new Map<ItemId, ItemId[]>();
      const meta = new Map<ItemId, ChromeNode>();
      const walk = (chromeId: string) => {
        const list: ItemId[] = [];
        for (const n of browser.children(chromeId)) {
          const item = itemOf(n.id);
          list.push(item);
          meta.set(item, n);
          walk(n.id);
        }
        if (list.length > 0) children.set(itemOf(chromeId), list);
      };
      for (const rootId of ROOT_CHROME.keys()) walk(rootId);
      const placed = placeChildren(children, previous);
      const live = new Map<ItemId, Bookmark>();
      for (const [item, n] of meta) {
        const location = placed.get(item);
        if (location === undefined) throw new Error('unplaced');
        live.set(item, n.url === null ? { kind: 'folder', title: n.title, location } : { kind: 'url', title: n.title, url: n.url, location });
      }
      return live;
    },

    async bind(aliases) {
      for (const [from, to] of aliases) idMap.set(chromeOf(from), to);
    },

    async apply({ current, target }, budget: Budget): Promise<ApplyResult> {
      const changes = diffLive(current, target);
      const depth = (id: ItemId): number => {
        const parent = target.get(id)?.location.parent;
        return parent === undefined ? 0 : 1 + depth(parent);
      };
      const adds = changes.filter((c) => c.op === 'add').sort((a, b) => depth(a.id) - depth(b.id));
      for (const add of adds) {
        if (budget.expired()) return { kind: 'stopped' };
        const parentChrome = chromeOf(add.after.location.parent);
        const chromeId = browser.add(parentChrome, browser.children(parentChrome).length, {
          title: add.after.title,
          ...(add.after.kind === 'url' ? { url: add.after.url } : {}),
        });
        await api.call('create');
        idMap.set(chromeId, add.id);
      }
      for (const change of changes) {
        if (change.op !== 'update') continue;
        const { before, after } = change;
        if (before.title === after.title && (before.kind !== 'url' || after.kind !== 'url' || before.url === after.url)) continue;
        if (budget.expired()) return { kind: 'stopped' };
        const node = browser.nodes.get(chromeOf(change.id));
        if (node === undefined) return { kind: 'interrupted', detail: `node ${change.id} vanished` };
        node.title = after.title;
        node.url = after.kind === 'url' ? after.url : null;
        await api.call('update');
      }
      for (const [parent, ordered] of childrenOf(target)) {
        const parentChrome = chromeOf(parent);
        for (const [index, item] of ordered.entries()) {
          const node = browser.nodes.get(chromeOf(item));
          if (node === undefined) return { kind: 'interrupted', detail: `node ${item} vanished` };
          if (node.parentId === parentChrome && node.index === index) continue;
          if (budget.expired()) return { kind: 'stopped' };
          browser.move(node.id, parentChrome, index);
          await api.call('move');
        }
      }
      const removes = changes.filter((c) => c.op === 'remove');
      const removedSubtree = new Set<ItemId>();
      for (const remove of removes) {
        if (removedSubtree.has(remove.id)) continue;
        if (budget.expired()) return { kind: 'stopped' };
        if (!idMap.has(chromeOf(remove.id))) continue;
        const chromeId = chromeOf(remove.id);
        const mark = (id: string) => {
          const item = idMap.get(id);
          if (item !== undefined) removedSubtree.add(item);
          for (const child of browser.children(id)) mark(child.id);
        };
        mark(chromeId);
        browser.remove(chromeId);
        await api.call('remove');
        for (const [cid, item] of idMap) if (removedSubtree.has(item)) idMap.delete(cid);
      }
      return { kind: 'applied' };
    },
  };
}

/**
 * Readable ItemIds for tests, from the node's title: `x-site_0`, and `x-site_0.2` for a second node with that
 * title. Content-derived, so a rerun after a crash mints the same id for the same node (the chrome adapter
 * mints uuids; identity is arbitrary either way).
 */
export function itemIds(prefix: string): (hint: string) => ItemId {
  const used = new Map<string, number>();
  return (hint) => {
    const slug = hint.replace(/[^0-9A-Za-z._-]/g, '_').slice(0, 40) || 'node';
    const n = (used.get(slug) ?? 0) + 1;
    used.set(slug, n);
    const id = `${prefix}-${slug}${n === 1 ? '' : `.${n}`}`;
    if (!isItemId(id)) throw new Error(id);
    return id;
  };
}

