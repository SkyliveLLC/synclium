// Synclium Cloud end to end in process: the engine, over cloud-store.ts, over the real server (support/cloud-server.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cloudStore, connectCloud } from '../src/cloud-store.ts';
import { createEngine } from '../src/engine.ts';
import { noAsks, unbounded, type Store } from '../src/ports.ts';
import { keys, openManifest } from '../src/store-format.ts';
import { cipherFor, mintSyncKey, vaultTokenFor, type SyncKey } from '../src/sync-key.ts';
import { readingListChannel } from '../src/chrome-reading-list.ts';
import type { DeviceId } from '../src/model.ts';
import type { Fetch } from '../src/webdav-store.ts';
import { deviceId, memoryLocal, memoryLogLocal, memorySink } from './support/memory-local.ts';
import { FakeBrowser, fakeBookmarks, itemIds } from './support/fake-bookmarks.ts';
import { FakeHistory } from './support/fake-history.ts';
import { FakeReadingList } from './support/fake-reading-list.ts';
import { FakeClock, TEST_KEY } from './support/harness.ts';
import { BAR, ground } from './support/ground.ts';
import { CLOUD_TEST_ORIGIN, cloudServer } from './support/cloud-server.ts';

/** One server, one clock, and devices whose every request is counted in `sent`. */
function rig() {
  const server = cloudServer();
  const clock = new FakeClock();
  const counter = { sent: 0 };
  const fetch: Fetch = (url, init) => {
    counter.sent++;
    return server.fetch(url, init);
  };
  let minted = 0;

  const add = (name: string, opts: { readonly browser?: FakeBrowser; readonly key?: SyncKey } = {}) => {
    const key = opts.key ?? TEST_KEY;
    const browser = opts.browser ?? new FakeBrowser();
    const local = memoryLocal(clock.skewed(0), () => deviceId(++minted));
    const history = new FakeHistory();
    const sink = memorySink();
    const engine = createEngine({
      connect: async (k) => connectCloud(await vaultTokenFor(k), fetch, CLOUD_TEST_ORIGIN),
      local,
      bookmarks: fakeBookmarks(browser, itemIds(name.toLowerCase())),
      readingList: readingListChannel(new FakeReadingList()),
      profile: null,
      history: { source: history, sink, local: memoryLogLocal() },
      extensions: { read: async () => null },
      clock: clock.skewed(0),
      platform: 'linux',
      appVersion: '0.0.0-test',
    });
    return {
      key,
      browser,
      history,
      sink,
      setup: () => local.reset({ name, historyOn: true, key }),
      preview: () => engine.sync({ preview: true, key }),
      async sync() {
        clock.tick(1000);
        const report = await engine.sync({ budget: unbounded, asks: noAsks });
        assert.ok(report.kind === 'cycle' && report.complete && report.store.access === 'ready', `${name} synced: ${JSON.stringify(report)}`);
      },
      get device(): DeviceId {
        const state = local.state();
        assert.ok(state !== null, `${name} is set up`);
        return state.device;
      },
    };
  };

  return { server, clock, counter, add };
}

type Rig = ReturnType<typeof rig>;

/** X starts from a profile and Y from nothing; both on TEST_KEY, each with one visit, synced both ways. */
async function syncedPair(r: Rig) {
  const x = r.add('X', { browser: ground() });
  const y = r.add('Y');
  await x.setup();
  await y.setup();
  x.history.add({ url: 'https://x.example/visit', title: 'x', t: r.clock.now - 5_000 });
  y.history.add({ url: 'https://y.example/visit', title: 'y', t: r.clock.now - 5_000 });
  await x.sync();
  await y.sync();
  await x.sync();
  return { x, y };
}

const storeFor = async (r: Rig, key: SyncKey): Promise<Store> => cloudStore(await vaultTokenFor(key), r.server.fetch, CLOUD_TEST_ORIGIN);

/** Every object key in the vault, sorted. A name with nothing under it is an object. */
async function vaultKeys(store: Store, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const name of await store.list(prefix)) {
    const below = await vaultKeys(store, `${prefix}${name}/`);
    out.push(...(below.length === 0 ? [`${prefix}${name}`] : below));
  }
  return out.sort();
}

/** What the devices' manifests vouch for: each manifest and every file it lists, sorted. */
async function vouchedKeys(store: Store, key: SyncKey, devices: readonly DeviceId[]): Promise<string[]> {
  const cipher = await cipherFor(key);
  const out: string[] = [];
  for (const device of devices) {
    const got = await store.get(keys.manifest(device), null);
    assert.ok(got.kind === 'ok', `${device} has a manifest`);
    const opened = await openManifest(got.bytes, device, cipher);
    assert.ok(opened.kind === 'ok', `${device}'s manifest opens`);
    out.push(keys.manifest(device), ...[...opened.manifest.files.keys()].map((rel) => keys.file(device, rel)));
  }
  return out.sort();
}

test('two devices on one key converge on bookmarks and history through the server', async () => {
  const r = rig();
  const { x, y } = await syncedPair(r);
  assert.equal(y.browser.render(), x.browser.render(), 'Y joined with X\'s bookmarks');
  assert.deepEqual(y.sink.visitsFrom(x.device).map((v) => v.url), ['https://x.example/visit']);
  assert.deepEqual(x.sink.visitsFrom(y.device).map((v) => v.url), ['https://y.example/visit']);

  y.browser.add(BAR, 0, { title: 'From Y', url: 'https://y.example/bookmark' });
  await y.sync();
  await x.sync();
  assert.equal(x.browser.find('From Y').length, 1, 'an edit on Y reaches X');
  assert.equal(x.browser.render(), y.browser.render());
});

test('after the server loses everything, one cycle each restores every file and edits still cross', async () => {
  const r = rig();
  const { x, y } = await syncedPair(r);
  const store = await storeFor(r, TEST_KEY);
  const before = await vaultKeys(store);
  assert.ok(before.some((k) => k.includes('/history/')), 'history days are among the files');

  r.server.wipe();
  assert.deepEqual(await vaultKeys(store), [], 'the vault is empty');
  await x.sync();
  await y.sync();
  const after = await vaultKeys(store);
  assert.deepEqual(after, await vouchedKeys(store, TEST_KEY, [x.device, y.device]), 'the vault holds exactly what the manifests vouch for');
  assert.deepEqual(after, before, 'every file is back');

  x.browser.add(BAR, 0, { title: 'After the wipe', url: 'https://x.example/after' });
  await x.sync();
  await y.sync();
  assert.equal(y.browser.find('After the wipe').length, 1);
  assert.equal(y.browser.render(), x.browser.render());
});

test('a device with another key previews a first device, with no other-key warning, and sees nothing of the group', async () => {
  const r = rig();
  await syncedPair(r);
  const z = r.add('Z', { key: mintSyncKey() });
  const preview = await z.preview();
  assert.equal(preview.kind, 'first-device');

  await z.setup();
  z.browser.add(BAR, 0, { title: 'Only Z', url: 'https://z.example/' });
  await z.sync();
  assert.deepEqual(z.browser.find('Site 0'), [], 'none of the group\'s bookmarks');
  assert.deepEqual([...z.sink.indexed().keys()], [], 'none of the group\'s history');
  const x = r.add('X2');
  await x.setup();
  await x.sync();
  assert.equal(x.browser.find('Site 0').length, 1, 'a new device on the group\'s key still joins it');
  assert.deepEqual(x.browser.find('Only Z'), [], 'and sees nothing of Z');
});

test('a steady-state cycle costs a small, fixed number of requests', async () => {
  const r = rig();
  const { x, y } = await syncedPair(r);
  await y.sync();
  for (const device of [x, y]) {
    const sent = r.counter.sent;
    await device.sync();
    assert.equal(r.counter.sent - sent, 3, 'its own manifest, the device list, and the peer\'s manifest');
  }
});
