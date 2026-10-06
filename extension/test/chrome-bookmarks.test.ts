// planApply against a model of chrome.bookmarks with Chromium's own rules: a move to a higher index within one
// folder counts the moved node itself, `remove` refuses a non-empty folder, and `create` needs a live parent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isItemId, type ItemId, type Live } from '../src/model.ts';
import { ROOTS, childrenOf, placeChildren, type Bookmark } from '../src/bookmarks.ts';
import { planApply, type BookmarkOp } from '../src/chrome-bookmarks.ts';

type Node = { title: string; url: string | null; parent: ItemId };

/** A profile keyed by ItemId, as the id map would make it. Children lists are in browser order. */
class Chromium {
  readonly nodes = new Map<ItemId, Node>();
  readonly kids = new Map<ItemId, ItemId[]>(Object.values(ROOTS).map((root) => [root, []]));

  #kids(parent: ItemId): ItemId[] {
    const list = this.kids.get(parent);
    if (list === undefined) throw new Error(`no folder ${parent}`);
    return list;
  }

  create(id: ItemId, parent: ItemId, index: number, title: string, url: string | null): void {
    const list = this.#kids(parent);
    if (index > list.length) throw new Error(`index ${index} past the end of ${parent}`);
    list.splice(index, 0, id);
    this.nodes.set(id, { title, url, parent });
    if (url === null) this.kids.set(id, []);
  }

  move(id: ItemId, parent: ItemId, index: number): void {
    const node = this.nodes.get(id);
    if (node === undefined) throw new Error(`no node ${id}`);
    for (let at: ItemId | undefined = parent; at !== undefined; at = this.nodes.get(at)?.parent)
      if (at === id) throw new Error(`cannot move ${id} into its own subtree`);
    const from = this.#kids(node.parent);
    const old = from.indexOf(id);
    from.splice(old, 1);
    const to = this.#kids(parent);
    to.splice(node.parent === parent && index > old ? index - 1 : index, 0, id);
    node.parent = parent;
  }

  update(id: ItemId, title: string, url: string | null): void {
    const node = this.nodes.get(id);
    if (node === undefined) throw new Error(`no node ${id}`);
    node.title = title;
    if (url !== null) node.url = url;
  }

  remove(id: ItemId, tree: boolean): void {
    const node = this.nodes.get(id);
    if (node === undefined) throw new Error(`no node ${id}`);
    if (!tree && (this.kids.get(id)?.length ?? 0) > 0) throw new Error(`remove on non-empty folder ${id}`);
    const drop = (at: ItemId) => {
      for (const child of this.kids.get(at) ?? []) drop(child);
      this.nodes.delete(at);
      this.kids.delete(at);
    };
    const siblings = this.#kids(node.parent);
    siblings.splice(siblings.indexOf(id), 1);
    drop(id);
  }

  run(ops: readonly BookmarkOp[]): void {
    for (const op of ops) {
      switch (op.op) {
        case 'create':
          this.create(op.id, op.record.location.parent, op.index, op.record.title, op.record.kind === 'url' ? op.record.url : null);
          break;
        case 'move':
          this.move(op.id, op.parent, op.index);
          break;
        case 'update':
          this.update(op.id, op.title, op.url);
          break;
        case 'remove':
          this.remove(op.id, op.tree);
          break;
      }
    }
  }

  /** What chrome-bookmarks.ts `read` would return: browser order turned into positions. */
  read(): Live<Bookmark> {
    const placed = placeChildren(this.kids, null);
    const live = new Map<ItemId, Bookmark>();
    for (const [id, node] of this.nodes) {
      const location = placed.get(id);
      if (location === undefined) throw new Error(`unplaced ${id}`);
      live.set(id, node.url === null ? { kind: 'folder', title: node.title, location } : { kind: 'url', title: node.title, url: node.url, location });
    }
    return live;
  }
}

/** Content and order, independent of positions: what the user sees. */
function shape(live: Live<Bookmark>): string {
  const children = childrenOf(live);
  const lines: string[] = [];
  const walk = (parent: ItemId, depth: number) => {
    for (const id of children.get(parent) ?? []) {
      const b = live.get(id);
      if (b === undefined) continue;
      lines.push(`${'  '.repeat(depth)}${id} ${b.title}${b.kind === 'url' ? ` ${b.url}` : '/'}`);
      walk(id, depth + 1);
    }
  };
  for (const root of Object.values(ROOTS)) {
    lines.push(root);
    walk(root, 1);
  }
  return lines.join('\n');
}

function item(name: string): ItemId {
  if (!isItemId(name)) throw new Error(name);
  return name;
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random profile over `ids`, where ids starting with `f` are folders. Parents come before children. */
function randomProfile(ids: readonly string[], rand: () => number, titleOf: (id: string) => string): Chromium {
  const chromium = new Chromium();
  const folders: ItemId[] = [...Object.values(ROOTS)];
  for (const name of [...ids].sort(() => rand() - 0.5)) {
    const id = item(name);
    const parent = folders[Math.floor(rand() * folders.length)] ?? ROOTS.bar;
    const index = Math.floor(rand() * ((chromium.kids.get(parent)?.length ?? 0) + 1));
    chromium.create(id, parent, index, titleOf(name), name.startsWith('f') ? null : `https://example.org/${name}`);
    if (name.startsWith('f')) folders.push(id);
  }
  return chromium;
}

test('running the plan makes the browser show exactly the target, for random trees under Chromium\'s move rules', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const rand = rng(seed);
    const pool = Array.from({ length: 24 }, (_, i) => `${rand() < 0.3 ? 'f' : 'u'}${i}`);
    const kept = pool.filter(() => rand() < 0.8);
    const added = Array.from({ length: 4 }, (_, i) => `${rand() < 0.4 ? 'f' : 'u'}new${i}`);
    const browser = randomProfile(kept, rand, (id) => `title ${id}`);
    const target = randomProfile(
      [...kept.filter(() => rand() < 0.75), ...added],
      rand,
      (id) => (rand() < 0.2 ? `renamed ${id}` : `title ${id}`),
    ).read();
    browser.run(planApply(browser.read(), target));
    assert.equal(shape(browser.read()), shape(target), `seed ${seed}`);
  }
});

test('a profile that already matches needs no calls', () => {
  const browser = randomProfile(['f1', 'u2', 'u3', 'f4', 'u5'], rng(7), (id) => id);
  const live = browser.read();
  assert.deepEqual(planApply(live, live), []);
});

test('a rename is one update and nothing else', () => {
  const browser = randomProfile(['f1', 'u2', 'u3', 'u4'], rng(3), (id) => id);
  const current = browser.read();
  const u3 = item('u3');
  const before = current.get(u3);
  assert.ok(before?.kind === 'url');
  const target = new Map(current).set(u3, { ...before, title: 'new title' });
  assert.deepEqual(planApply(current, target), [{ op: 'update', id: u3, title: 'new title', url: before.url }]);
});

test('a folder that goes with its contents is one removeTree, and its descendants get no calls of their own', () => {
  const browser = new Chromium();
  browser.create(item('f1'), ROOTS.bar, 0, 'folder', null);
  browser.create(item('u2'), item('f1'), 0, 'inside', 'https://example.org/2');
  browser.create(item('f3'), item('f1'), 1, 'nested', null);
  browser.create(item('u4'), item('f3'), 0, 'deep', 'https://example.org/4');
  browser.create(item('u5'), ROOTS.bar, 1, 'stays', 'https://example.org/5');
  const current = browser.read();
  const target = new Map([...current].filter(([id]) => id === item('u5')));
  assert.deepEqual(planApply(current, target), [{ op: 'remove', id: item('f1'), tree: true }]);
});
