// Synclium Cloud from the extension's side: the vault token the sync key derives, and cloud-store.ts against a
// stub that answers the HTTP contract (synthesis "HTTP") without being a server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cipherFor, mintSyncKey, parseSyncKey, vaultTokenFor, type SyncKey, type VaultToken } from '../src/sync-key.ts';
import { CLOUD_LABEL, allowCloud, chooseCloud, cloudStore, connectCloud } from '../src/cloud-store.ts';
import { StoreError, type StoreFailure } from '../src/ports.ts';
import { keys, shardRel } from '../src/store-format.ts';
import { history } from '../src/history.ts';
import { dayOf } from '../src/model.ts';
import type { Fetch } from '../src/webdav-store.ts';
import { deviceId } from './support/memory-local.ts';

function syncKey(text: string): SyncKey {
  const key = parseSyncKey(text);
  assert.ok(key !== null, text);
  return key;
}

const FIXED_KEY = syncKey('0123456789ABCDEFGHJKMNPQRSTVWXYZ0123456789ABCDEFGHJ0');
const TOKEN = await vaultTokenFor(FIXED_KEY);
const ORIGIN = 'https://cloud.test';
const A = deviceId(1);
const B = deviceId(2);
const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

// Every chrome.* access is recorded: Synclium Cloud must never ask for a permission or read one.
const touched: string[] = [];
Object.assign(globalThis, { chrome: new Proxy({}, { get: (_, prop) => void touched.push(String(prop)) }) });

type Sent = { readonly method: string; readonly url: string; readonly headers: Headers; readonly init: RequestInit; status?: number };

/** The contract's answers, one vault per bearer token. Knobs stand in for a busy, broken, or unreachable server. */
class StubCloud {
  readonly vaults = new Map<string, Map<string, Uint8Array>>();
  readonly log: Sent[] = [];
  /** The next request's status, whatever it asked. */
  failNext: number | null = null;
  /** The next request rejects with this, as fetch does offline or on the timeout. */
  rejectNext: Error | null = null;
  /** A list answer other than `{"names": [...]}`. */
  listBody: string | null = null;
  /** A proxy that strips ETag, or one that drops If-None-Match. */
  hideEtag = false;
  ignoreIfNoneMatch = false;
  /** Gets answer 200 and then the body fails mid-read. */
  cutBodies = false;

  readonly fetch: Fetch = async (url, init) => {
    const sent: Sent = { method: init.method ?? 'GET', url, headers: new Headers(init.headers), init };
    this.log.push(sent);
    const res = await this.#answer(sent);
    sent.status = res.status;
    return res;
  };

  async #answer({ method, url, headers, init }: Sent): Promise<Response> {
    const reject = this.rejectNext;
    this.rejectNext = null;
    if (reject !== null) throw reject;
    const status = this.failNext;
    this.failNext = null;
    if (status !== null) return new Response(status === 304 ? null : 'nope', { status });
    const path = url.slice(ORIGIN.length);
    if (path === '/v1/health') return Response.json({ ok: true });
    const auth = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(headers.get('Authorization') ?? '')?.[1];
    if (auth === undefined || !path.startsWith('/v1/o/')) return new Response(null, { status: auth === undefined ? 401 : 404 });
    const vault = this.vaults.get(auth) ?? new Map<string, Uint8Array>();
    this.vaults.set(auth, vault);
    const key = path.slice('/v1/o/'.length);
    if (method === 'GET' && (key === '' || key.endsWith('/'))) {
      const names = [...vault.keys()].filter((k) => k.startsWith(key)).map((k) => k.slice(key.length).split('/')[0] ?? '');
      return new Response(this.listBody ?? JSON.stringify({ names: [...new Set(names)].sort() }), { headers: { 'Content-Type': 'application/json' } });
    }
    const etagOf = (body: Uint8Array) => `"${createHash('sha256').update(body).digest('base64url')}"`;
    if (method === 'PUT') {
      const body = new Uint8Array(await new Response(init.body).arrayBuffer());
      vault.set(key, body);
      return new Response(null, { status: 204, headers: { ETag: etagOf(body) } });
    }
    if (method === 'DELETE') {
      vault.delete(key);
      return new Response(null, { status: 204 });
    }
    const body = vault.get(key);
    if (body === undefined) return new Response('not found', { status: 404 });
    const etag = etagOf(body);
    if (!this.ignoreIfNoneMatch && headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
    const stream = this.cutBodies ? new ReadableStream({ start: (c) => c.error(new TypeError('network error')) }) : body.slice();
    return new Response(stream, { headers: this.hideEtag ? {} : { ETag: etag } });
  }
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

const storeOn = (cloud: StubCloud, token: VaultToken = TOKEN) => cloudStore(token, cloud.fetch, ORIGIN);

test('the vault token is pinned: changing its derivation would orphan every vault', async () => {
  assert.equal(TOKEN, 'f53gI-xhod936ODZF2_sMRSuL_pQWBWkbmKmw3RsPJY');
});

test('the vault token follows the key and shares nothing with the key id or the key', async () => {
  assert.equal(await vaultTokenFor(FIXED_KEY), TOKEN, 'every device with the key finds the same vault');
  assert.notEqual(await vaultTokenFor(mintSyncKey()), TOKEN, 'another key, another vault');
  const keyId = (await cipherFor(FIXED_KEY)).keyId;
  assert.ok(!Buffer.from(TOKEN, 'base64url').toString('hex').includes(keyId), 'the token does not carry the key id');
  assert.ok(!TOKEN.includes(FIXED_KEY.slice(0, 8)), 'the token does not carry the key');
});

test('connect and allow send nothing and ask for nothing', async () => {
  const cloud = new StubCloud();
  const conn = connectCloud(TOKEN, cloud.fetch, ORIGIN);
  assert.equal(conn.access, 'ready');
  assert.equal(conn.access === 'ready' && conn.label, CLOUD_LABEL);
  assert.deepEqual(await allowCloud(), { access: 'ready', label: CLOUD_LABEL });
  assert.deepEqual(cloud.log, [], 'connect sends no requests');
  assert.deepEqual(touched, [], 'no chrome API, so no permission, is touched');
});

test('get: missing, then a version, then unchanged on a 304, then the rewrite; the same bytes keep their version', async () => {
  const cloud = new StubCloud();
  const store = storeOn(cloud);
  const manifest = keys.manifest(A);
  assert.deepEqual(await store.get(manifest, null), { kind: 'missing' });
  await store.put(manifest, bytes('v1'));
  const first = await store.get(manifest, null);
  assert.ok(first.kind === 'ok');
  assert.equal(text(first.bytes), 'v1');
  assert.deepEqual(await store.get(manifest, first.version), { kind: 'unchanged' });
  assert.equal(cloud.log.at(-1)?.headers.get('If-None-Match'), first.version, 'the version goes back as If-None-Match');
  assert.equal(cloud.log.at(-1)?.status, 304, 'an unchanged peer costs a 304, no body');

  await store.put(manifest, bytes('v2'));
  const second = await store.get(manifest, first.version);
  assert.ok(second.kind === 'ok' && second.version !== first.version);
  assert.equal(text(second.bytes), 'v2');
  await store.put(manifest, bytes('v2'));
  assert.deepEqual(await store.get(manifest, second.version), { kind: 'unchanged' }, 'a retried put of the same bytes reads as unchanged');

  cloud.ignoreIfNoneMatch = true;
  assert.deepEqual(await store.get(manifest, second.version), { kind: 'unchanged' }, 'a 200 with the known ETag is still unchanged');
});

test('list is one level, an unknown vault is empty, and any other answer is refused', async () => {
  const cloud = new StubCloud();
  const store = storeOn(cloud);
  await store.put(keys.manifest(A), bytes('a'));
  await store.put(keys.file(A, shardRel(history, dayOf(Date.UTC(2026, 9, 20)))), bytes('day'));
  await store.put(keys.manifest(B), bytes('b'));
  assert.deepEqual(await store.list(''), ['devices']);
  assert.deepEqual(await store.list('devices/'), [A, B]);
  assert.deepEqual(await store.list(`devices/${A}/`), ['history', 'manifest.json']);
  assert.deepEqual(await storeOn(cloud, await vaultTokenFor(mintSyncKey())).list('devices/'), [], 'another key sees an empty vault, never missing');

  for (const body of ['{"names":[1]}', '{"files":[]}', '["devices"]', 'null', '<html>proxy error</html>']) {
    cloud.listBody = body;
    assert.deepEqual(await failureOf(store.list('devices/')), { kind: 'rejected', detail: 'Synclium Cloud sent an unexpected answer' }, body);
  }
});

test('delete is idempotent, and probes pass at once and leave nothing behind', async () => {
  const cloud = new StubCloud();
  const store = storeOn(cloud);
  await store.delete(keys.manifest(A));
  await store.put(keys.manifest(A), bytes('a'));
  await store.delete(keys.manifest(A));
  await store.delete(keys.manifest(A));
  assert.deepEqual(await store.get(keys.manifest(A), null), { kind: 'missing' });
  assert.deepEqual(await Promise.all([store.probe(), store.probe()]), [{ kind: 'ok' }, { kind: 'ok' }]);
  assert.deepEqual(await store.list(''), [], 'probes leave nothing');
});

test('failures become the popup words; the store is never missing and never needs a permission', async () => {
  const cloud = new StubCloud();
  const store = storeOn(cloud);
  const manifest = keys.manifest(A);
  const expected: readonly (readonly [number, StoreFailure])[] = [
    [429, { kind: 'unreachable', detail: 'busy, retrying in a few minutes' }],
    [500, { kind: 'unreachable', detail: 'server error 500' }],
    [503, { kind: 'unreachable', detail: 'server error 503' }],
    [413, { kind: 'rejected', detail: 'a file is too large' }],
    [507, { kind: 'rejected', detail: 'this sync group is out of space' }],
    [400, { kind: 'rejected', detail: 'HTTP 400' }],
    [401, { kind: 'rejected', detail: 'HTTP 401' }],
    [404, { kind: 'rejected', detail: 'HTTP 404' }],
  ];
  for (const [status, why] of expected) {
    cloud.failNext = status;
    assert.deepEqual(await failureOf(store.put(manifest, bytes('m'))), why, `PUT ${status}`);
    cloud.failNext = status;
    assert.deepEqual(await failureOf(store.list('devices/')), why, `list ${status}`);
  }
  cloud.failNext = 503;
  assert.deepEqual(await store.probe(), { kind: 'failed', why: { kind: 'unreachable', detail: 'server error 503' } });

  cloud.rejectNext = new TypeError('Failed to fetch');
  assert.deepEqual(await failureOf(store.delete(manifest)), { kind: 'unreachable', detail: 'Failed to fetch' });
  cloud.rejectNext = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  assert.deepEqual(await failureOf(store.get(manifest, null)), { kind: 'unreachable', detail: 'The operation was aborted due to timeout' });

  await store.put(manifest, bytes('m'));
  cloud.cutBodies = true;
  assert.deepEqual(await failureOf(store.get(manifest, null)), { kind: 'unreachable', detail: 'network error' }, 'a body cut mid-read');
  cloud.cutBodies = false;
  cloud.hideEtag = true;
  assert.deepEqual(await failureOf(store.get(manifest, null)), { kind: 'rejected', detail: 'Synclium Cloud sent no version' });
});

test('every request carries the token, no cookies, no cache, and a timeout', async () => {
  const cloud = new StubCloud();
  const store = storeOn(cloud);
  await store.put(keys.manifest(A), bytes('a'));
  await store.get(keys.manifest(A), null);
  await store.list('devices/');
  await store.delete(keys.manifest(A));
  assert.deepEqual(
    cloud.log.map((s) => s.url),
    [`${ORIGIN}/v1/o/devices/${A}/manifest.json`, `${ORIGIN}/v1/o/devices/${A}/manifest.json`, `${ORIGIN}/v1/o/devices/`, `${ORIGIN}/v1/o/devices/${A}/manifest.json`],
  );
  for (const { headers, init } of cloud.log) {
    assert.equal(headers.get('Authorization'), `Bearer ${TOKEN}`);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.cache, 'no-store');
    assert.ok(init.signal instanceof AbortSignal && !init.signal.aborted, 'a live timeout signal');
  }
  assert.deepEqual(touched, []);
});

test('choosing Synclium Cloud checks the server answers, with no token, and saves nothing when it does not', async () => {
  // Node has no IndexedDB, so a choice that tried to save the candidate would reject instead of resolving.
  const cloud = new StubCloud();
  cloud.failNext = 503;
  assert.deepEqual(await chooseCloud(cloud.fetch, ORIGIN), { kind: 'chosen', label: CLOUD_LABEL, probe: { kind: 'failed', why: { kind: 'unreachable', detail: 'server error 503' } } });
  cloud.rejectNext = new TypeError('Failed to fetch');
  assert.deepEqual(await chooseCloud(cloud.fetch, ORIGIN), { kind: 'chosen', label: CLOUD_LABEL, probe: { kind: 'failed', why: { kind: 'unreachable', detail: 'Failed to fetch' } } });
  assert.deepEqual(
    cloud.log.map((s) => [s.method, s.url, s.headers.has('Authorization')]),
    [
      ['GET', `${ORIGIN}/v1/health`, false],
      ['GET', `${ORIGIN}/v1/health`, false],
    ],
  );
  assert.deepEqual(touched, [], 'nothing was asked');
});
