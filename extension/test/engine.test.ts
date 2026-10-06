// Engine behaviour around the store: torn files, lapsed access, the mass-delete guard, rollback, identity
// clash, idle rejoin, and the setup preview.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAY_MS, isDeviceId } from '../src/model.ts';
import { encodeManifest, keys, parseManifest } from '../src/store-format.ts';
import { World, Crasher, syncedPair, type Device } from './support/harness.ts';
import type { SyncReport } from '../src/engine.ts';
import { ground, idOf, urlTitle, OTHER } from './support/ground.ts';
import { visitsOver } from './support/fake-history.ts';

const cycleReport = async (d: Device): Promise<Extract<SyncReport, { kind: 'cycle' }>> => {
  const report = await d.cycle();
  if (report.kind !== 'cycle') throw new Error(`expected a cycle report, got ${report.kind}`);
  return report;
};

test('a file still mid-transfer reads as not-yet and the last good copy stands until the transfer completes', async () => {
  const world = new World('icloud');
  const { x, y } = await syncedPair(world);
  x.browser.rename(idOf(x.browser, urlTitle(10)), 'torn-title');
  x.attached.knobs.tearNextPushes = 1;
  await x.cycle();
  const report = await cycleReport(y);
  assert.deepEqual(report.warnings, [{ kind: 'not-yet', peer: x.device, file: 'bookmarks.hsync' }], 'Y names the torn file');
  assert.equal(report.bookmarks.kind, 'synced');
  assert.equal(y.browser.find(urlTitle(10)).length, 1, 'Y keeps the last good copy: the old title');
  assert.equal(y.browser.find('torn-title').length, 0);
  x.push();
  const healed = await cycleReport(y);
  assert.deepEqual(healed.warnings, [], 'the completed transfer parses');
  assert.equal(y.browser.find('torn-title').length, 1, 'Y applies the rename once the bytes match the manifest');
});

test('new bytes under an old manifest are never read; the writer\'s rerun publishes the manifest and the peer catches up', async () => {
  const world = new World('icloud');
  const crasher = new Crasher();
  const { x, y } = await syncedPair(world, { x: { crasher } });
  x.browser.rename(idOf(x.browser, urlTitle(10)), 'new-title');
  x.pull();
  crasher.arm(1, 'after', 'put');
  await assert.rejects(x.sync(), /killed after call 1 \(put\)/, 'X dies after writing bookmarks.hsync, before its manifest');
  x.push();
  const stale = await cycleReport(y);
  assert.deepEqual(stale.warnings, [], 'the old manifest names the hash Y already holds, so the new bytes are not even fetched');
  assert.equal(y.browser.find(urlTitle(10)).length, 1, 'Y keeps the old title');
  await x.cycle();
  const fresh = await cycleReport(y);
  assert.deepEqual(fresh.warnings, []);
  assert.equal(y.browser.find('new-title').length, 1);
});

test('store not ready: a local-only cycle stamps the edit at edit time, so a peer\'s later edit still wins when access returns', async () => {
  const world = new World('icloud');
  const { x, y } = await syncedPair(world);
  x.access = { kind: 'needs-permission' };
  x.browser.rename(idOf(x.browser, urlTitle(20)), 'X-while-paused');
  const paused = await cycleReport(x);
  assert.deepEqual(paused.store, { access: 'failed', label: 'memory', why: { kind: 'needs-permission' } });
  assert.equal(paused.bookmarks.kind, 'synced');
  if (paused.bookmarks.kind === 'synced') assert.equal(paused.bookmarks.stamped, 1, 'the rename was stamped and committed locally');
  world.clock.tick(1000);
  y.browser.rename(idOf(y.browser, urlTitle(20)), 'Y-a-second-later');
  await y.cycle();
  world.clock.tick(3_600_000);
  x.access = 'ready';
  await x.cycle();
  await y.cycle();
  await x.cycle();
  assert.equal(x.browser.find('Y-a-second-later').length, 1, 'Y\'s edit, made after X\'s, wins on X');
  assert.equal(y.browser.find('Y-a-second-later').length, 1, 'and stays on Y');
  assert.equal(x.browser.find('X-while-paused').length, 0, 'X\'s earlier edit did not win by being published later');
});

test('a lapsed grant also publishes everything committed meanwhile, including history days', async () => {
  const world = new World('icloud');
  const { x, y } = await syncedPair(world);
  x.access = { kind: 'needs-permission' };
  x.browser.add(OTHER, 0, { title: 'offline-add', url: 'https://x.example/offline' });
  x.history.add({ url: 'https://x.example/visit', title: 'v', t: world.clock.now - 5_000 });
  const paused = await cycleReport(x);
  if (paused.history.kind !== 'synced') throw new Error('history is on');
  assert.equal(paused.history.unpublishedDays, 1, 'the day is committed locally, not in the store');
  x.access = 'ready';
  const resumed = await cycleReport(x);
  if (resumed.history.kind !== 'synced') throw new Error('history is on');
  assert.equal(resumed.history.unpublishedDays, 0);
  assert.equal(resumed.history.publishedDays, 1);
  await y.cycle();
  assert.equal(y.browser.find('offline-add').length, 1);
  assert.equal(y.sink.visitsFrom(x.device).length, 1);
});

test('mass-delete guard blocks a profile that lost most of its bookmarks, and the applyDeletions ask lets it through', async () => {
  const world = new World('icloud');
  const { x, y } = await syncedPair(world);
  const before = y.browser.render();
  for (let i = 0; i < 25; i++) x.browser.remove(idOf(x.browser, urlTitle(i)));
  const blocked = await cycleReport(x);
  assert.equal(blocked.bookmarks.kind, 'blocked');
  if (blocked.bookmarks.kind === 'blocked' && blocked.bookmarks.why.kind === 'mass-delete') {
    assert.equal(blocked.bookmarks.why.removed.removed, 25);
    assert.equal(blocked.bookmarks.why.of, y.channel.idMap.size);
  } else assert.fail(`expected mass-delete, got ${JSON.stringify(blocked.bookmarks)}`);
  await y.cycle();
  assert.equal(y.browser.render(), before, 'nothing was published: Y still has every bookmark');
  const stillBlocked = await cycleReport(x);
  assert.equal(stillBlocked.bookmarks.kind, 'blocked', 'the block holds until the user asks');
  const forced = await x.cycle(undefined, { rederiveHistory: 0, applyDeletions: 1 });
  assert.equal(forced.kind === 'cycle' && forced.bookmarks.kind, 'synced');
  await y.cycle();
  assert.equal(y.browser.find(urlTitle(0)).length, 0, 'the confirmed deletions reached Y');
  assert.equal(y.browser.find(urlTitle(29)).length, 1, 'the surviving bookmarks stayed');
  const again = await cycleReport(x);
  assert.equal(again.bookmarks.kind, 'synced', 'the same ask count does not re-trigger anything, and nothing is left to force');
});

test('rollback: a peer manifest with a lower seq than seen is ignored and the index keeps the newer day', async () => {
  const world = new World('icloud');
  const { x, y } = await syncedPair(world);
  const dayA = world.clock.now - DAY_MS;
  x.history.add({ url: 'https://x.example/a', title: 'a', t: dayA });
  await x.cycle(undefined, { rederiveHistory: 1, applyDeletions: 0 });
  await y.cycle();
  const beforeB = world.cloud.snapshot();
  x.history.add({ url: 'https://x.example/b', title: 'b', t: world.clock.now - 1000 });
  await x.cycle();
  await y.cycle();
  assert.equal(y.sink.visitsFrom(x.device).length, 2, 'Y indexed both days');
  world.cloud.restore(beforeB);
  const report = await cycleReport(y);
  assert.deepEqual(report.warnings, [{ kind: 'rollback', peer: x.device }]);
  assert.equal(y.sink.visitsFrom(x.device).length, 2, 'the rolled-back manifest did not drop day B from the index');
  const republished = await cycleReport(x);
  assert.deepEqual(republished.warnings, [], 'X notices its own manifest went backwards and republishes');
  const manifest = world.cloud.files.get(keys.manifest(x.device));
  assert.ok(manifest !== undefined);
  assert.equal(parseManifest(manifest.data, x.device)?.files.size, 3, 'bookmarks plus both days are back in the store');
  const after = await cycleReport(y);
  assert.deepEqual(after.warnings, []);
});

test('identity clash: a manifest under our DeviceId with a higher seq stops the cycle before anything runs', async () => {
  const world = new World('icloud');
  const { x } = await syncedPair(world);
  const ownFile = world.cloud.files.get(keys.manifest(x.device));
  assert.ok(ownFile !== undefined);
  const parsed = parseManifest(ownFile.data, x.device);
  assert.ok(parsed !== null);
  x.attached.local.set(keys.manifest(x.device), { data: encodeManifest({ ...parsed, seq: parsed.seq + 10 }), rev: 99, ver: 99, dirty: false });
  x.browser.rename(idOf(x.browser, urlTitle(1)), 'should-not-stamp');
  const report = await x.sync();
  assert.deepEqual(report, { kind: 'identity-clash', at: world.clock.now, device: x.device });
  const own = x.local.state()?.bookmarks?.own;
  assert.ok(own !== undefined);
  for (const entry of own.values()) assert.notEqual(entry.fields.title[0], 'should-not-stamp', 'the rename was not folded: nothing ran');
});

test('idle past the window: the device deletes its files and rejoins under a new id by adoption', async () => {
  const world = new World('icloud');
  const { x, y } = await syncedPair(world);
  const old = x.device;
  world.clock.tick(91 * DAY_MS);
  await y.cycle();
  const report = await cycleReport(x);
  assert.deepEqual(report.warnings, [{ kind: 'rejoined', previous: old }]);
  assert.notEqual(x.device, old);
  assert.ok(isDeviceId(x.device));
  assert.equal([...world.cloud.files.keys()].filter((k) => k.includes(old)).length, 0, 'old device files are gone');
  await y.cycle();
  await x.cycle();
  assert.equal(x.browser.render(), y.browser.render(), 'the rejoined device matched everything by content');
  assert.equal(x.browser.find(urlTitle(0)).length, 1, 'no duplicates after rejoin');
});

test('preview reports the join without writing sync state or the store', async () => {
  const world = new World('icloud');
  const x = world.add('X', { browser: ground() });
  await x.setup();
  for (const v of visitsOver(world.clock.now, 3, 2, 'x.example')) x.history.add(v);
  await x.cycle();
  const zTree = ground();
  zTree.remove(idOf(zTree, urlTitle(0)));
  zTree.add(OTHER, 0, { title: 'z-new', url: 'https://z.example/' });
  const z = world.add('Z', { browser: zTree });
  z.pull();
  const filesBefore = [...world.cloud.files.keys()];
  const preview = await z.preview();
  assert.deepEqual(preview, {
    kind: 'joining',
    label: 'memory',
    peers: ['X'],
    bookmarks: { matched: zTree.nodes.size - 3 - 1, toAdd: 1, toPublish: 1 },
    historyDays: 3,
  });
  assert.equal(z.local.state(), null, 'preview wrote no sync state');
  z.push();
  assert.deepEqual([...world.cloud.files.keys()], filesBefore, 'preview wrote nothing to the store');
  z.access = { kind: 'missing' };
  assert.deepEqual(await z.preview(), { kind: 'not-ready', store: { access: 'failed', label: 'memory', why: { kind: 'missing' } } });
});

test('a device that was never set up reports needs-setup', async () => {
  const world = new World('icloud');
  const x = world.add('X');
  assert.deepEqual(await x.sync(), { kind: 'needs-setup', at: world.clock.now });
});
