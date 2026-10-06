// folder-store.ts against an in-memory File System Access volume (support/fake-fsa.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STORE_NAME, allowRoot, connectRoot, folderStore, storeRootIn } from '../src/folder-store.ts';
import { StoreError, type Store, type StoreFailure } from '../src/ports.ts';
import { keys, shardRel } from '../src/store-format.ts';
import { history } from '../src/history.ts';
import { dayOf } from '../src/model.ts';
import { deviceId } from './support/memory-local.ts';
import { FakeDir, FakeVolume } from './support/fake-fsa.ts';
import { createEngine } from '../src/engine.ts';
import { gzipJson } from '../src/store-format.ts';
import { noAsks, unbounded } from '../src/ports.ts';
import { FakeBrowser, fakeBookmarks, itemIds } from './support/fake-bookmarks.ts';
import { FakeHistory } from './support/fake-history.ts';
import { memoryLocal, memoryLogLocal, memorySink } from './support/memory-local.ts';
import { FakeClock } from './support/harness.ts';
import { BAR, ground } from './support/ground.ts';

const A = deviceId(1);
const manifestKey = keys.manifest(A);
const shardKey = keys.file(A, shardRel(history, dayOf(Date.UTC(2026, 9, 6))));
const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** A volume holding an initialized store, as setup leaves it. */
async function storeOn(): Promise<{ vol: FakeVolume; root: FakeDir; store: Store }> {
  const vol = new FakeVolume();
  const root = await storeRootIn(vol.root);
  const conn = await connectRoot(root);
  assert.equal(conn.access, 'ready');
  return { vol, root, store: folderStore(root) };
}

async function failureOf(call: Promise<unknown>): Promise<StoreFailure> {
  try {
    await call;
  } catch (error) {
    if (error instanceof StoreError) return error.why;
    throw error;
  }
  assert.fail('expected a StoreError');
}

test('a lapsed grant gives no store, and a store held across the lapse writes nothing', async () => {
  const { vol, root, store } = await storeOn();
  await store.put(manifestKey, bytes('v1'));
  vol.permission = 'prompt';

  assert.deepEqual(await connectRoot(root), { access: 'failed', label: STORE_NAME, why: { kind: 'needs-permission' } });
  assert.deepEqual(await failureOf(store.put(manifestKey, bytes('v2'))), { kind: 'needs-permission' });
  assert.deepEqual(await failureOf(store.put(shardKey, bytes('day'))), { kind: 'needs-permission' });
  assert.deepEqual(await failureOf(store.get(manifestKey, null)), { kind: 'needs-permission' });
  assert.deepEqual(await failureOf(store.list('devices/')), { kind: 'needs-permission' });
  assert.deepEqual(await store.probe(), { kind: 'failed', why: { kind: 'needs-permission' } });

  vol.permission = 'granted';
  assert.equal(vol.text(`${STORE_NAME}/${manifestKey}`), 'v1');
  assert.equal(vol.at(`${STORE_NAME}/${shardKey}`), undefined);
});

test('connect: no handle is not set up, a moved folder is missing', async () => {
  const { vol, root } = await storeOn();
  assert.deepEqual(await connectRoot(undefined), { access: 'not-set-up' });
  vol.root.entries.delete(STORE_NAME);
  assert.deepEqual(await connectRoot(root), { access: 'failed', label: STORE_NAME, why: { kind: 'missing' } });
});

test('a folder moved mid-cycle fails as missing, never as an empty store', async () => {
  const { vol, store } = await storeOn();
  await store.put(manifestKey, bytes('v1'));
  vol.root.entries.delete(STORE_NAME);
  assert.deepEqual(await failureOf(store.list('devices/')), { kind: 'missing' });
  assert.deepEqual(await failureOf(store.get(manifestKey, null)), { kind: 'missing' });
  assert.deepEqual(await failureOf(store.delete(manifestKey)), { kind: 'missing' });
  assert.deepEqual(await store.probe(), { kind: 'failed', why: { kind: 'missing' } });
});

test('get reads bytes once, then answers unchanged until lastModified or size moves', async () => {
  const { vol, store } = await storeOn();
  assert.deepEqual(await store.get(manifestKey, null), { kind: 'missing' });
  await store.put(manifestKey, bytes('aaaa'));

  const first = await store.get(manifestKey, null);
  assert.equal(first.kind, 'ok');
  if (first.kind !== 'ok') return;
  assert.equal(text(first.bytes), 'aaaa');

  const reads = vol.reads;
  assert.deepEqual(await store.get(manifestKey, first.version), { kind: 'unchanged' });
  assert.equal(vol.reads, reads, 'an unchanged file costs no byte read');

  // A peer's sync client rewrites the file at the same size: P7 saw lastModified move.
  vol.write(`${STORE_NAME}/${manifestKey}`, bytes('bbbb'));
  const sameSize = await store.get(manifestKey, first.version);
  assert.equal(sameSize.kind === 'ok' && text(sameSize.bytes), 'bbbb');
  if (sameSize.kind !== 'ok') return;

  vol.write(`${STORE_NAME}/${manifestKey}`, bytes('ccccc'), { keepModified: true });
  const sameTime = await store.get(manifestKey, sameSize.version);
  assert.equal(sameTime.kind === 'ok' && text(sameTime.bytes), 'ccccc');
});

test('put swaps in the new bytes and leaves no .crswap; a failed write keeps the old bytes', async () => {
  const { vol, store } = await storeOn();
  await store.put(shardKey, bytes('one'));
  await store.put(shardKey, bytes('two'));
  assert.equal(vol.text(`${STORE_NAME}/${shardKey}`), 'two');

  vol.failNextWrite = 'QuotaExceededError';
  const why = await failureOf(store.put(shardKey, bytes('three')));
  assert.equal(why.kind, 'rejected');
  assert.match(why.kind === 'rejected' ? why.detail : '', /QuotaExceededError/);
  assert.equal(vol.text(`${STORE_NAME}/${shardKey}`), 'two');
  assert.deepEqual(await store.list(`devices/${A}/history/`), [shardKey.split('/').at(-1)]);
});

test('list returns one level of names, leftover swap files included, and nothing for an absent folder', async () => {
  const { vol, store } = await storeOn();
  assert.deepEqual(await store.list('devices/'), []);
  assert.deepEqual(await store.list(`devices/${A}/`), []);
  await store.put(shardKey, bytes('day'));
  await store.put(manifestKey, bytes('m'));
  vol.write(`${STORE_NAME}/devices/manifest.json.crswap`, bytes('torn'));

  assert.deepEqual(await store.list('devices/'), [A, 'manifest.json.crswap']);
  assert.deepEqual(await store.list(`devices/${A}/`), ['history', 'manifest.json']);
});

test('delete is idempotent and removes the folders it empties, but never devices/', async () => {
  const { vol, store } = await storeOn();
  await store.put(shardKey, bytes('day'));
  await store.put(manifestKey, bytes('m'));

  await store.delete(shardKey);
  await store.delete(shardKey);
  assert.equal(vol.at(`${STORE_NAME}/devices/${A}/history`), undefined);
  assert.deepEqual(await store.list(`devices/${A}/`), ['manifest.json']);

  await store.delete(manifestKey);
  assert.deepEqual(await store.list('devices/'), []);
  assert.ok(vol.at(`${STORE_NAME}/devices`) instanceof FakeDir);
});

test('probe writes, reads back, and leaves nothing behind', async () => {
  const { root, store } = await storeOn();
  assert.deepEqual(await store.probe(), { kind: 'ok' });
  assert.deepEqual([...root.entries.keys()], ['devices']);
});

test('picking the store, its parent, or a fresh folder all land on the store root', async () => {
  const fresh = new FakeVolume();
  const created = await storeRootIn(fresh.root);
  assert.equal(created.name, STORE_NAME);
  assert.ok(fresh.at(`${STORE_NAME}/devices`) instanceof FakeDir, 'a new store gets devices/ so the next device recognizes it');

  const parent = await storeRootIn(fresh.root);
  assert.equal(parent, created, 'the parent of an existing store resolves to it, not to a second store');
  assert.equal(await storeRootIn(created), created);

  const renamed = new FakeVolume();
  renamed.write('Sync/devices/x/manifest.json', bytes('m'));
  const sync = renamed.at('Sync');
  assert.ok(sync instanceof FakeDir);
  assert.equal(await storeRootIn(sync), sync, 'a store under another name is still a store');
  assert.equal(sync.entries.has(STORE_NAME), false);
});

test('allow asks once and reports what the user answered', async () => {
  const { vol, root } = await storeOn();
  vol.permission = 'prompt';
  vol.answer = 'denied';
  assert.deepEqual(await allowRoot(root), { access: 'failed', label: STORE_NAME, why: { kind: 'needs-permission' } });
  vol.answer = 'granted';
  assert.deepEqual(await allowRoot(root), { access: 'ready', label: STORE_NAME });
  assert.deepEqual(await allowRoot(undefined), { access: 'not-set-up' });
});

test('through the engine: a paused device commits edits locally and publishes them once access returns', async () => {
  const vol = new FakeVolume();
  const root = await storeRootIn(vol.root);
  const world = new FakeClock();
  const clock = world.skewed(0);
  let minted = 0;
  const device = (browser: FakeBrowser, name: string) => {
    const local = memoryLocal(clock, () => deviceId(++minted));
    const engine = createEngine({
      connect: () => connectRoot(root),
      local,
      bookmarks: fakeBookmarks(browser, itemIds(name)),
      history: { source: new FakeHistory(), sink: memorySink(), local: memoryLogLocal() },
      codec: gzipJson,
      clock,
      platform: 'mac',
      appVersion: '0.0.0-test',
    });
    return { browser, local, sync: () => engine.sync({ budget: unbounded, asks: noAsks }) };
  };
  const x = device(ground(), 'x');
  const y = device(new FakeBrowser(), 'y');
  await x.local.reset({ name: 'X', historyOn: false });
  await y.local.reset({ name: 'Y', historyOn: false });
  await x.sync();
  world.tick(1000);
  await y.sync();
  assert.equal(y.browser.render(), x.browser.render(), 'Y joined from the folder');

  vol.permission = 'prompt';
  x.browser.add(BAR, 0, { title: 'While paused', url: 'https://example.com/paused' });
  world.tick(1000);
  const before = vol.text(`${STORE_NAME}/devices/${deviceId(1)}/manifest.json`);
  const paused = await x.sync();
  assert.equal(paused.kind === 'cycle' && paused.store.access === 'failed' && paused.store.why.kind, 'needs-permission');
  vol.permission = 'granted';
  assert.equal(vol.text(`${STORE_NAME}/devices/${deviceId(1)}/manifest.json`), before, 'nothing was published while paused');

  world.tick(1000);
  await x.sync();
  world.tick(1000);
  await y.sync();
  assert.equal(y.browser.render(), x.browser.render());
  assert.match(y.browser.render(), /While paused/);
});
