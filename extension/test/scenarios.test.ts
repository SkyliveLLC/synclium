// P3's scenario suite ported onto engine.sync. Two or three devices over one folder, in both folder modes.
// Each scenario asserts convergence, zero folder conflicts (one writer per key), and that no write was lost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAY_MS } from '../src/model.ts';
import { World, Crasher, syncedPair as pairIn, type Device } from './support/harness.ts';
import { ground, idOf, urlTitle, F_TITLE, BAR } from './support/ground.ts';
import type { FolderMode } from './support/memory-store.ts';

const MODES: readonly FolderMode[] = ['dropbox', 'icloud'];

async function syncedPair(mode: FolderMode, skewY = 0): Promise<{ world: World; x: Device; y: Device }> {
  const world = new World(mode);
  const { x, y } = await pairIn(world, { y: { skewMs: skewY } });
  return { world, x, y };
}

const u = (i: number) => urlTitle(i + 10);
const newUrl = (title: string) => ({ title, url: `https://example.com/${title}` });

/** Duplicate (parent, title, url) triples, as P3 counted them. The ground tree has none. */
function dupCount(d: Device): number {
  const seen = new Map<string, number>();
  for (const n of d.browser.nodes.values()) {
    if (n.url === null) continue;
    const key = `${n.parentId}|${n.title}|${n.url}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen.values()].filter((c) => c > 1).reduce((a, c) => a + c - 1, 0);
}

for (const mode of MODES) {
  test(`[${mode}] 1 concurrent add + rename-other: both edits survive`, async () => {
    const { world, x, y } = await syncedPair(mode);
    x.browser.add(BAR, 0, newUrl('n1'));
    y.browser.rename(idOf(y.browser, u(1)), 'Y-renamed');
    await x.syncUntilComplete();
    await y.syncUntilComplete();
    x.push();
    y.push();
    x.pull();
    y.pull();
    await world.converge();
    world.noFolderConflicts();
    assert.equal(x.browser.find('n1').length, 1, 'X add kept');
    assert.equal(x.browser.find('Y-renamed').length, 1, 'Y rename kept');
  });

  test(`[${mode}] 2 move-into-F vs delete-F: delete wins, the moved bookmark survives under the nearest live ancestor`, async () => {
    const { world, x, y } = await syncedPair(mode);
    const moved = 'Other 0';
    x.browser.move(idOf(x.browser, moved), idOf(x.browser, F_TITLE), 0);
    y.browser.remove(idOf(y.browser, F_TITLE));
    await x.syncUntilComplete();
    await y.syncUntilComplete();
    x.push();
    y.push();
    x.pull();
    y.pull();
    await world.converge();
    world.noFolderConflicts();
    assert.equal(x.browser.find(F_TITLE).length, 0, 'F deleted');
    assert.equal(x.browser.find(moved).length, 1, 'moved bookmark survives');
    assert.equal(x.browser.parentTitleOf(moved), `root ${BAR}`, 'moved bookmark re-homed under F\'s parent, not reverted to Other');
  });

  test(`[${mode}] 3 same-field rename, Y one second later: the later edit wins`, async () => {
    const { world, x, y } = await syncedPair(mode);
    x.browser.rename(idOf(x.browser, u(2)), 'X-title');
    await x.syncUntilComplete();
    world.clock.tick(1000);
    y.browser.rename(idOf(y.browser, u(2)), 'Y-title');
    await y.syncUntilComplete();
    x.push();
    y.push();
    x.pull();
    y.pull();
    await world.converge();
    world.noFolderConflicts();
    assert.equal(x.browser.find('Y-title').length, 1, 'later edit (Y) wins');
    assert.equal(x.browser.find('X-title').length, 0);
  });

  test(`[${mode}] 3b same as 3 with Y's clock 10 min slow: converges (which edit wins is the accepted skew flip)`, async () => {
    const { world, x, y } = await syncedPair(mode, -600_000);
    x.browser.rename(idOf(x.browser, u(2)), 'X-title');
    await x.syncUntilComplete();
    world.clock.tick(1000);
    y.browser.rename(idOf(y.browser, u(2)), 'Y-title');
    await y.syncUntilComplete();
    x.push();
    y.push();
    x.pull();
    y.pull();
    await world.converge();
    world.noFolderConflicts();
    assert.equal(x.browser.find('X-title').length + x.browser.find('Y-title').length, 1, 'exactly one title survives on both devices');
  });

  test(`[${mode}] 4 X offline a week: offline edits keep their stamps, so the later edit wins per field`, async () => {
    const { world, x, y } = await syncedPair(mode);
    x.browser.rename(idOf(x.browser, u(3)), 'X-offline');
    x.browser.add(BAR, 0, newUrl('n4'));
    await x.syncUntilComplete();
    world.clock.tick(3 * DAY_MS);
    y.browser.rename(idOf(y.browser, u(3)), 'Y-day3');
    y.browser.rename(idOf(y.browser, u(5)), 'Y-other');
    await y.cycle();
    world.clock.tick(3 * DAY_MS);
    x.browser.rename(idOf(x.browser, u(6)), 'X-day6');
    await x.syncUntilComplete();
    world.clock.tick(DAY_MS);
    x.push();
    x.pull();
    await world.converge();
    world.noFolderConflicts();
    assert.equal(x.browser.find('n4').length, 1, 'X offline add kept');
    assert.equal(x.browser.find('X-day6').length, 1, 'X day6 rename kept');
    assert.equal(x.browser.find('Y-other').length, 1, 'Y rename kept');
    assert.equal(x.browser.find('Y-day3').length, 1, 'u3: later (Y day3) wins over X\'s offline rename');
    assert.equal(x.browser.find('X-offline').length, 0);
  });

  test(`[${mode}] 5 crash after the store write: the rerun publishes the same state, nothing doubles`, async () => {
    const world = new World(mode);
    const crasher = new Crasher();
    const { x, y } = await pairIn(world, { x: { crasher } });
    y.browser.rename(idOf(y.browser, u(8)), 'Y-8');
    await y.cycle();
    x.browser.add(BAR, 0, newUrl('n5'));
    x.browser.rename(idOf(x.browser, u(7)), 'X-7');
    x.pull();
    crasher.arm(1, 'after', 'put');
    await assert.rejects(x.sync(), /killed after call 1 \(put\)/, 'the first store write of this cycle is the kill point');
    x.push();
    await x.syncUntilComplete();
    x.push();
    await world.converge();
    world.noFolderConflicts();
    assert.equal(x.browser.find('n5').length, 1, 'n5 exactly once');
    assert.equal(x.browser.find('X-7').length, 1, 'X rename kept');
    assert.equal(x.browser.find('Y-8').length, 1, 'Y rename kept');
  });

  test(`[${mode}] 6 Z joins with its own copy of the tree: adoption prevents duplicates and keeps Z's extra`, async () => {
    const { world, x, y } = await syncedPair(mode);
    x.browser.remove(idOf(x.browser, u(-10)));
    await x.cycle();
    await y.cycle();
    const zTree = ground();
    zTree.add(BAR, 0, newUrl('z-only'));
    const z = world.add('Z', { browser: zTree });
    await z.setup();
    z.pull();
    const preview = await z.preview();
    assert.equal(preview.kind, 'joining');
    if (preview.kind === 'joining') {
      assert.equal(preview.bookmarks.toPublish, 2, 'preview: z-only and Z\'s copy of the deleted bookmark are new to the store');
      assert.equal(preview.bookmarks.toAdd, 0, 'preview: nothing to add here');
    }
    await z.cycle();
    await world.converge();
    world.noFolderConflicts();
    assert.equal(dupCount(z), 0, 'no duplicates');
    assert.equal(z.browser.find('z-only').length, 1, 'Z-only kept');
    // The extension has no guid, so Z's local copy of the bookmark X deleted is a new item, not the tombstoned one.
    assert.equal(z.browser.find(u(-10)).length, 1, 'Z\'s copy of X\'s deleted bookmark comes along as a new item, once');
  });

  test(`[${mode}] 6b Y forgets and sets up again: the kept id map ties its nodes to X's tombstone, so X's delete is honored`, async () => {
    const { world, x, y } = await syncedPair(mode);
    x.browser.remove(idOf(x.browser, u(-10)));
    await x.cycle();
    const forgotten = y.device;
    y.pull();
    await y.engine.forget();
    y.push();
    assert.equal([...world.cloud.files.keys()].filter((k) => k.includes(forgotten)).length, 0, 'forget removed every file of the old device');
    await y.setup();
    assert.equal(y.browser.find(u(-10)).length, 1, 'Y still shows the bookmark before rejoining');
    await y.cycle();
    await world.converge();
    world.noFolderConflicts();
    assert.equal(y.browser.find(u(-10)).length, 0, 'X delete honored on the rejoined device');
    assert.equal(dupCount(y), 0, 'no duplicates after rejoin');
  });

  test(`[${mode}] 7 X adds, Y deletes it before X resyncs: the delete is honored`, async () => {
    const { world, x, y } = await syncedPair(mode);
    x.browser.add(BAR, 0, newUrl('n7'));
    await x.cycle();
    y.pull();
    await y.syncUntilComplete();
    assert.equal(y.browser.find('n7').length, 1, 'Y applied the add');
    y.browser.remove(idOf(y.browser, 'n7'));
    await y.cycle();
    x.pull();
    await world.converge();
    world.noFolderConflicts();
    assert.equal(x.browser.find('n7').length, 0, 'Y delete honored');
  });
}
