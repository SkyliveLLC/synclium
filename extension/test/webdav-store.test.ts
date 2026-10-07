// webdav-store.ts against an in-memory WebDAV server (support/fake-dav.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { childNames, connectWebdav, labelOf, parseDavUrl, webdavRootIn, webdavStore, type DavUrl, type WebdavConfig } from '../src/webdav-store.ts';
import { StoreError, noAsks, unbounded, type Store, type StoreFailure } from '../src/ports.ts';
import { STORE_NAME, gzipJson, keys, shardRel } from '../src/store-format.ts';
import { history } from '../src/history.ts';
import { dayOf } from '../src/model.ts';
import { createEngine } from '../src/engine.ts';
import { deviceId, memoryLocal, memoryLogLocal, memorySink } from './support/memory-local.ts';
import { FakeBrowser, fakeBookmarks, itemIds } from './support/fake-bookmarks.ts';
import { FakeHistory } from './support/fake-history.ts';
import { FakeClock } from './support/harness.ts';
import { BAR, ground } from './support/ground.ts';
import { FakeDav } from './support/fake-dav.ts';

const A = deviceId(1);
const manifestKey = keys.manifest(A);
const shardKey = keys.file(A, shardRel(history, dayOf(Date.UTC(2026, 9, 6))));
const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const STORE = `${STORE_NAME}/`;

function davUrl(s: string): DavUrl {
  const url = parseDavUrl(s);
  assert.ok(url !== null, s);
  return url;
}

/** A server holding an initialized store, as setup leaves it. */
async function storeOn(): Promise<{ dav: FakeDav; config: WebdavConfig; store: Store }> {
  const dav = new FakeDav();
  const config = await webdavRootIn({ url: davUrl(dav.home), username: 'me', password: 'secret' }, dav.fetch);
  return { dav, config, store: webdavStore(config, dav.fetch) };
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

test('parseDavUrl takes https collections, and http only to this machine', () => {
  assert.equal(parseDavUrl(' https://cloud.example.com/remote.php/dav/files/me '), 'https://cloud.example.com/remote.php/dav/files/me/');
  assert.equal(parseDavUrl('http://localhost:8080/dav/'), 'http://localhost:8080/dav/');
  for (const bad of ['cloud.example.com', 'http://nas.local/dav/', 'http://[::1]/dav/', 'ftp://x/', 'https://me:pw@x.com/', 'https://x.com/?a=1', 'https://x.com/#h', 'https://x.com/100%/', '']) {
    assert.equal(parseDavUrl(bad), null, bad);
  }
});

test('childNames reads any prefix, absolute or path hrefs, and escapes, and drops the collection itself', () => {
  const dir = 'https://cloud.example.com/remote.php/dav/files/me/Helium%20Sync/';
  const xml = `<?xml version="1.0"?>
    <d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
      <d:response><d:href>/remote.php/dav/files/me/Helium%20Sync/</d:href></d:response>
      <d:response><d:href>/remote.php/dav/files/me/Helium%20Sync/devices/</d:href></d:response>
      <d:response><d:href>https://cloud.example.com/remote.php/dav/files/me/Helium%20Sync/a%20%26%20b.json</d:href></d:response>
      <d:response><d:href>/remote.php/dav/files/me/Helium Sync/x&amp;y</d:href></d:response>
    </d:multistatus>`;
  assert.deepEqual(childNames(xml, dir), ['a & b.json', 'devices', 'x&y']);
});

test('childNames trusts depth, not the path we sent, so a proxy that respells it still lists children', () => {
  const dir = 'https://nas.example.com/dav/Files/';
  const rows = (...hrefs: string[]) => `<D:multistatus xmlns:D="DAV:">${hrefs.map((h) => `<D:response><D:href>${h}</D:href></D:response>`).join('')}</D:multistatus>`;
  assert.deepEqual(childNames(rows('/webdav/files/', '/webdav/files/devices/', '/webdav/files/a.json'), dir), ['a.json', 'devices']);
  assert.deepEqual(childNames(rows('/webdav/files/'), dir), [], 'an empty collection is only itself');
  assert.deepEqual(childNames(rows('/webdav/files/manifest.json'), dir), ['manifest.json'], 'one row that is not the collection is a child');
  assert.deepEqual(childNames(rows('/webdav/files/a', '/webdav/files/b'), dir), ['a', 'b'], 'a server that omits the collection row');
});

test('setup finds the store in the typed collection, in its Helium Sync child, or creates it', async () => {
  const dav = new FakeDav();
  const typed: WebdavConfig = { url: davUrl(dav.home), username: 'me', password: 'secret' };
  const created = await webdavRootIn(typed, dav.fetch);
  assert.equal(created.url, `${dav.home}Helium%20Sync/`);
  assert.ok(dav.hasDir(`${STORE}devices/`), 'a new store gets devices/ so the next device recognizes it');
  assert.equal(labelOf(created), 'Helium Sync on dav.test');

  assert.deepEqual(await webdavRootIn(typed, dav.fetch), created, 'the parent of an existing store resolves to it');
  assert.deepEqual(await webdavRootIn(created, dav.fetch), created, 'so does the store itself');

  dav.write('Sync/devices/x/manifest.json', 'm');
  const renamed = { ...typed, url: davUrl(`${dav.home}Sync/`) };
  assert.deepEqual(await webdavRootIn(renamed, dav.fetch), renamed, 'a store under another name is still a store');

  const nowhere = { ...typed, url: davUrl(`${dav.home}nope/`) };
  assert.deepEqual(await failureOf(webdavRootIn(nowhere, dav.fetch)), { kind: 'missing' });
});

test('get reads bytes once, then a 304 answers unchanged until a peer rewrites the file', async () => {
  const { dav, store } = await storeOn();
  assert.deepEqual(await store.get(manifestKey, null), { kind: 'missing' });
  await store.put(manifestKey, bytes('aaaa'));

  const first = await store.get(manifestKey, null);
  assert.ok(first.kind === 'ok');
  assert.equal(text(first.bytes), 'aaaa');
  assert.deepEqual(await store.get(manifestKey, first.version), { kind: 'unchanged' });

  dav.write(`${STORE}${manifestKey}`, 'bbbb');
  const rewritten = await store.get(manifestKey, first.version);
  assert.equal(rewritten.kind === 'ok' && text(rewritten.bytes), 'bbbb');
});

test('without ETags the version is a content hash: unchanged holds, a same-size rewrite is seen', async () => {
  const { dav, store } = await storeOn();
  dav.etags = false;
  await store.put(manifestKey, bytes('aaaa'));
  const first = await store.get(manifestKey, null);
  assert.ok(first.kind === 'ok');
  assert.match(first.version, /^sha256:/);
  assert.deepEqual(await store.get(manifestKey, first.version), { kind: 'unchanged' });

  dav.write(`${STORE}${manifestKey}`, 'bbbb');
  const rewritten = await store.get(manifestKey, first.version);
  assert.equal(rewritten.kind === 'ok' && text(rewritten.bytes), 'bbbb');
});

test('put makes missing folders once; list returns one level of names and nothing for an absent folder', async () => {
  const { dav, store } = await storeOn();
  assert.deepEqual(await store.list('devices/'), []);
  assert.deepEqual(await store.list(`devices/${A}/`), []);

  await store.put(shardKey, bytes('day'));
  assert.equal(dav.text(`${STORE}${shardKey}`), 'day');
  const puts = dav.log.length;
  await store.put(shardKey, bytes('day 2'));
  assert.equal(dav.log.length - puts, 1, 'a rewrite is one PUT');
  await store.put(manifestKey, bytes('m'));

  assert.deepEqual(await store.list('devices/'), [A]);
  assert.deepEqual(await store.list(`devices/${A}/`), ['history', 'manifest.json']);
});

test('delete is idempotent and removes the folders it empties, but never devices/', async () => {
  const { dav, store } = await storeOn();
  await store.put(shardKey, bytes('day'));
  await store.put(manifestKey, bytes('m'));

  await store.delete(shardKey);
  await store.delete(shardKey);
  assert.equal(dav.hasDir(`${STORE}devices/${A}/history/`), false);
  assert.deepEqual(await store.list(`devices/${A}/`), ['manifest.json']);

  await store.delete(manifestKey);
  assert.deepEqual(await store.list('devices/'), []);
  assert.ok(dav.hasDir(`${STORE}devices/`));
});

test('a store deleted on the server fails as missing, never as an empty store or a folder to recreate', async () => {
  const { dav, store } = await storeOn();
  await store.put(manifestKey, bytes('v1'));
  dav.removeDir(STORE);
  assert.deepEqual(await failureOf(store.list('devices/')), { kind: 'missing' });
  assert.deepEqual(await failureOf(store.get(manifestKey, null)), { kind: 'missing' });
  assert.deepEqual(await failureOf(store.delete(manifestKey)), { kind: 'missing' });
  assert.deepEqual(await failureOf(store.put(manifestKey, bytes('v2'))), { kind: 'missing' });
  assert.deepEqual(await store.probe(), { kind: 'failed', why: { kind: 'missing' } });
  assert.equal(dav.hasDir(STORE), false);
});

test('behind a proxy that respells paths, list still sees peers and delete keeps non-empty folders', async () => {
  const { dav, store } = await storeOn();
  await store.put(shardKey, bytes('day'));
  await store.put(keys.file(A, shardRel(history, dayOf(Date.UTC(2026, 9, 5)))), bytes('older day'));
  await store.put(manifestKey, bytes('m'));
  dav.hrefPrefix = '/proxied';
  assert.deepEqual(await store.list('devices/'), [A]);
  await store.delete(shardKey);
  assert.deepEqual(await store.list(`devices/${A}/history/`), ['2026-10-05.hsync']);
  assert.equal(dav.text(`${STORE}${manifestKey}`), 'm');
});

test('probe writes, reads back, and leaves nothing; failures become the popup words', async () => {
  const { dav, config, store } = await storeOn();
  assert.deepEqual(await Promise.all([store.probe(), store.probe()]), [{ kind: 'ok' }, { kind: 'ok' }], 'two probes at once never read each other');
  assert.deepEqual(await store.list(''), ['devices'], 'probes leave nothing behind');

  const wrong = webdavStore({ ...config, password: 'nope' }, dav.fetch);
  assert.deepEqual(await wrong.probe(), { kind: 'failed', why: { kind: 'rejected', detail: 'wrong username or password' } });

  dav.failNext = 503;
  assert.deepEqual(await failureOf(store.list('devices/')), { kind: 'unreachable', detail: 'server error 503' });
  dav.failNext = 507;
  assert.deepEqual(await failureOf(store.put(manifestKey, bytes('m'))), { kind: 'rejected', detail: 'the server is out of space' });

  dav.offline = true;
  assert.deepEqual(await store.probe(), { kind: 'failed', why: { kind: 'unreachable', detail: 'Failed to fetch' } });
});

test('connect never prompts: a revoked host permission reads as needs-permission', async () => {
  const { dav, config } = await storeOn();
  const sent = dav.log.length;
  let granted = false;
  const asked: unknown[] = [];
  Object.assign(globalThis, {
    chrome: {
      permissions: {
        contains: async (p: unknown) => {
          asked.push(p);
          return granted;
        },
      },
    },
  });
  assert.deepEqual(await connectWebdav(config, dav.fetch), { access: 'failed', label: 'Helium Sync on dav.test', why: { kind: 'needs-permission' } });
  assert.deepEqual(asked, [{ origins: ['https://dav.test/*'] }]);
  granted = true;
  const conn = await connectWebdav(config, dav.fetch);
  assert.equal(conn.access, 'ready');
  assert.equal(dav.log.length, sent, 'connect sends no requests');
});

test('through the engine: two devices sync over WebDAV, and an offline device publishes once back', async () => {
  const { dav, config } = await storeOn();
  const world = new FakeClock();
  const clock = world.skewed(0);
  let minted = 0;
  const device = (browser: FakeBrowser, name: string) => {
    const local = memoryLocal(clock, () => deviceId(++minted));
    const engine = createEngine({
      connect: async () => ({ access: 'ready', label: labelOf(config), store: webdavStore(config, dav.fetch) }),
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
  assert.equal(y.browser.render(), x.browser.render(), 'Y joined from the server');

  dav.offline = true;
  x.browser.add(BAR, 0, { title: 'While offline', url: 'https://example.com/offline' });
  world.tick(1000);
  const paused = await x.sync();
  assert.equal(paused.kind === 'cycle' && paused.store.access === 'failed' && paused.store.why.kind, 'unreachable');
  dav.offline = false;

  world.tick(1000);
  await x.sync();
  world.tick(1000);
  await y.sync();
  assert.equal(y.browser.render(), x.browser.render());
  assert.match(y.browser.render(), /While offline/);
});
