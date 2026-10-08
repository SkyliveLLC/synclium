// drive-store.ts against an in-memory Google Drive (support/fake-drive.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driveRootIn, driveStore, labelOf, type Auth, type DriveConfig } from '../src/drive-store.ts';
import { StoreError, noAsks, unbounded, type Store, type StoreFailure } from '../src/ports.ts';
import { STORE_NAME, keys, shardRel } from '../src/store-format.ts';
import { history } from '../src/history.ts';
import { dayOf } from '../src/model.ts';
import { createEngine } from '../src/engine.ts';
import { deviceId, memoryLocal, memoryLogLocal, memorySink } from './support/memory-local.ts';
import { FakeBrowser, fakeBookmarks, itemIds } from './support/fake-bookmarks.ts';
import { FakeHistory } from './support/fake-history.ts';
import { FakeClock, TEST_KEY } from './support/harness.ts';
import { FakeReadingList } from './support/fake-reading-list.ts';
import { readingListChannel } from '../src/chrome-reading-list.ts';
import { BAR, ground } from './support/ground.ts';
import { FakeDrive } from './support/fake-drive.ts';

const A = deviceId(1);
const manifestKey = keys.manifest(A);
const shardKey = keys.file(A, shardRel(history, dayOf(Date.UTC(2026, 9, 6))));
const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const STORE = `${STORE_NAME}/`;

/** Hands out t1; once t1 is refused, t2 if Drive accepts it, else the silent renewal fails. */
const auth: (drive: FakeDrive) => Auth = (drive) => async (stale) => {
  if (stale === null) return 't1';
  if (!drive.valid.has('t2')) throw new StoreError({ kind: 'needs-permission' });
  return 't2';
};

/** A Drive holding an initialized store, as setup leaves it. */
async function storeOn(): Promise<{ drive: FakeDrive; config: DriveConfig; store: Store }> {
  const drive = new FakeDrive();
  const config = { folder: await driveRootIn(auth(drive), drive.fetch), account: drive.account };
  return { drive, config, store: driveStore(config, auth(drive), drive.fetch) };
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

test('setup creates one Helium Sync folder with devices/, and every later device finds it, even after a move', async () => {
  const drive = new FakeDrive();
  const first = await driveRootIn(auth(drive), drive.fetch);
  assert.equal(drive.at(STORE)?.id, first);
  assert.ok(drive.at(`${STORE}devices/`), 'a new store gets devices/ so the next device recognizes it');
  assert.equal(await driveRootIn(auth(drive), drive.fetch), first, 'a second device joins the same folder');

  const moved = drive.create('root', 'Archive', true);
  const folder = drive.nodes.get(first);
  assert.ok(folder);
  folder.parent = moved.id;
  assert.equal(await driveRootIn(auth(drive), drive.fetch), first, 'found wherever the user moved it');
  assert.equal(labelOf({ folder: first, account: drive.account }), 'Google Drive (me@example.com)');
});

test('get downloads once, then the md5 answers unchanged until a peer rewrites the file', async () => {
  const { drive, store } = await storeOn();
  assert.deepEqual(await store.get(manifestKey, null), { kind: 'missing' });
  await store.put(manifestKey, bytes('aaaa'));

  const first = await store.get(manifestKey, null);
  assert.ok(first.kind === 'ok');
  assert.equal(text(first.bytes), 'aaaa');
  const sent = drive.log.length;
  assert.deepEqual(await store.get(manifestKey, first.version), { kind: 'unchanged' });
  assert.ok(!drive.log.slice(sent).some((line) => line.includes(`/files/${drive.at(`${STORE}${manifestKey}`)?.id}`)), 'unchanged downloads nothing');

  drive.write(`${STORE}${manifestKey}`, 'bbbb');
  const rewritten = await store.get(manifestKey, first.version);
  assert.equal(rewritten.kind === 'ok' && text(rewritten.bytes), 'bbbb');
});

test('put makes missing folders once and rewrites in place; list returns one level of names', async () => {
  const { drive, store } = await storeOn();
  assert.deepEqual(await store.list('devices/'), []);
  assert.deepEqual(await store.list(`devices/${A}/`), []);

  await store.put(shardKey, bytes('day'));
  await store.put(shardKey, bytes('day 2'));
  assert.equal(drive.text(`${STORE}${shardKey}`), 'day 2');
  assert.equal([...drive.nodes.values()].filter((n) => n.name === shardKey.split('/').at(-1)).length, 1, 'a rewrite never duplicates the file');
  await store.put(manifestKey, bytes('m'));

  assert.deepEqual(await store.list('devices/'), [A]);
  assert.deepEqual(await store.list(`devices/${A}/`), ['history', 'manifest.json']);
});

test('delete is idempotent and removes the folders it empties, but never devices/', async () => {
  const { drive, store } = await storeOn();
  await store.put(shardKey, bytes('day'));
  await store.put(manifestKey, bytes('m'));

  await store.delete(shardKey);
  await store.delete(shardKey);
  assert.equal(drive.at(`${STORE}devices/${A}/history/`), undefined);
  assert.deepEqual(await store.list(`devices/${A}/`), ['manifest.json']);

  await store.delete(manifestKey);
  assert.deepEqual(await store.list('devices/'), []);
  assert.ok(drive.at(`${STORE}devices/`));
});

test('a store trashed in Drive fails as missing, and is never recreated', async () => {
  const { drive, config, store } = await storeOn();
  await store.put(manifestKey, bytes('v1'));
  const root = drive.nodes.get(config.folder);
  assert.ok(root);
  root.trashed = true;
  const fresh = driveStore(config, auth(drive), drive.fetch); // a new cycle, with no folder ids cached
  assert.deepEqual(await failureOf(fresh.list('devices/')), { kind: 'missing' });
  assert.deepEqual(await failureOf(fresh.get(manifestKey, null)), { kind: 'missing' });
  assert.deepEqual(await failureOf(fresh.put(manifestKey, bytes('v2'))), { kind: 'missing' });
  assert.deepEqual(await fresh.probe(), { kind: 'failed', why: { kind: 'missing' } });
  assert.equal([...drive.nodes.values()].filter((n) => n.name === 'devices').length, 1, 'nothing was recreated');
});

test('probe leaves nothing; a lapsed token renews once, else needs-permission; Drive errors become popup words', async () => {
  const { drive, store } = await storeOn();
  assert.deepEqual(await Promise.all([store.probe(), store.probe()]), [{ kind: 'ok' }, { kind: 'ok' }]);
  assert.deepEqual(await store.list(''), ['devices'], 'probes leave nothing behind');

  drive.valid.clear();
  drive.valid.add('t2');
  assert.deepEqual(await store.list('devices/'), [], 'renewed after a 401');
  drive.valid.clear();
  assert.deepEqual(await failureOf(store.list('devices/')), { kind: 'needs-permission' });
  drive.valid.add('t2');

  drive.failNext = { status: 403, body: '{"error":{"errors":[{"reason":"storageQuotaExceeded"}]}}' };
  assert.deepEqual(await failureOf(store.put(manifestKey, bytes('m'))), { kind: 'rejected', detail: 'your Google Drive is full' });
  drive.failNext = { status: 403, body: '{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}' };
  assert.deepEqual(await failureOf(store.list('devices/')), { kind: 'unreachable', detail: 'Google Drive asked to slow down' });
  drive.offline = true;
  assert.deepEqual(await store.probe(), { kind: 'failed', why: { kind: 'unreachable', detail: 'Failed to fetch' } });
});

test('through the engine: two devices sync over Google Drive', async () => {
  const { drive, config } = await storeOn();
  const world = new FakeClock();
  const clock = world.skewed(0);
  let minted = 0;
  const device = (browser: FakeBrowser, name: string) => {
    const local = memoryLocal(clock, () => deviceId(++minted));
    const engine = createEngine({
      connect: async () => ({ access: 'ready', label: labelOf(config), store: driveStore(config, auth(drive), drive.fetch) }),
      local,
      bookmarks: fakeBookmarks(browser, itemIds(name)),
      readingList: readingListChannel(new FakeReadingList()),
      profile: null,
      history: { source: new FakeHistory(), sink: memorySink(), local: memoryLogLocal() },
      extensions: { read: async () => null },
      clock,
      platform: 'mac',
      appVersion: '0.0.0-test',
    });
    return { browser, local, sync: () => engine.sync({ budget: unbounded, asks: noAsks }) };
  };
  const x = device(ground(), 'x');
  const y = device(new FakeBrowser(), 'y');
  await x.local.reset({ name: 'X', historyOn: false, key: TEST_KEY });
  await y.local.reset({ name: 'Y', historyOn: false, key: TEST_KEY });
  await x.sync();
  world.tick(1000);
  await y.sync();
  assert.equal(y.browser.render(), x.browser.render(), 'Y joined from Drive');

  x.browser.add(BAR, 0, { title: 'From X', url: 'https://example.com/from-x' });
  world.tick(1000);
  await x.sync();
  world.tick(1000);
  await y.sync();
  assert.match(y.browser.render(), /From X/);
});
