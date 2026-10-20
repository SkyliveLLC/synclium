// The HTTP contract through `handle`, against real SQLite (':memory:' or a temp file), with an injected clock and
// disk. One test per route-table row and per limit.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createCloud, type Disk } from '../src/app.ts';
import type { Limits } from '../src/limits.ts';
import { openVaults, type Vaults } from '../src/vaults.ts';

const TOKEN_A = 'A'.repeat(43);
const TOKEN_B = `${'b'.repeat(41)}_-`;
const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const IP = '203.0.113.7';
const DAY_MS = 86_400_000;
const GiB = 1024 ** 3;

type Send = {
  readonly token?: string | null;
  readonly origin?: string;
  readonly ip?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>;
};

/** A cloud over `vaults` whose clock and disk the test moves. */
function rig(options: { readonly vaults?: Vaults; readonly limits?: Partial<Limits> } = {}) {
  const vaults = options.vaults ?? openVaults(':memory:');
  const clock = { now: 1_800_000_000_000 };
  const disk: { current: Disk } = { current: { freeBytes: 100 * GiB, dataBytes: 0 } };
  const cloud = createCloud({ vaults, ...(options.limits === undefined ? {} : { limits: options.limits }), now: () => clock.now, disk: () => disk.current });
  const send = (method: string, path: string, { token = TOKEN_A, origin, ip = IP, headers = {}, body }: Send = {}): Promise<Response> => {
    const all: Record<string, string> = { ...headers };
    if (token !== null) all['Authorization'] = `Bearer ${token}`;
    if (origin !== undefined) all['Origin'] = origin;
    const init: RequestInit = body === undefined ? { method, headers: all } : { method, headers: all, body, duplex: 'half' };
    return cloud.handle(new Request(`http://cloud.test${path}`, init), { ip });
  };
  return { vaults, clock, disk, send };
}

const bytes = (length: number, fill = 7) => new Uint8Array(length).fill(fill);
const etagOf = (body: Uint8Array) => `"${createHash('sha256').update(body).digest('base64url')}"`;
const names = async (response: Response) => ((await response.json()) as { names: string[] }).names;

/** A body stream of `chunks`, counting how many chunks the server pulled. */
function streamOf(chunks: readonly Uint8Array<ArrayBuffer>[]) {
  const pulled = { count: 0 };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[pulled.count];
        pulled.count++;
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 }, // pull only when read
  );
  return { stream, pulled };
}

function tempDb(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'synclium-cloud-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'cloud.sqlite');
}

test('GET /v1/health answers {"ok":true} without a token, and 503 when the database fails', async () => {
  const { vaults, send } = rig();
  const ok = await send('GET', '/v1/health', { token: null });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });
  vaults.close();
  assert.equal((await send('GET', '/v1/health', { token: null })).status, 503);
});

test('OPTIONS answers 204 with the preflight headers, without a token', async () => {
  const { send } = rig();
  const res = await send('OPTIONS', '/v1/o/devices/x/manifest.json', { token: null, origin: ORIGIN });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(res.headers.get('Access-Control-Allow-Methods'), 'GET, PUT, DELETE');
  assert.equal(res.headers.get('Access-Control-Allow-Headers'), 'Authorization, If-None-Match, Content-Type');
  assert.equal(res.headers.get('Access-Control-Max-Age'), '7200');
});

test('GET /v1/o/ and /v1/o/<prefix>/ list direct children, sorted and unique; an unknown vault lists []', async () => {
  const { send } = rig();
  for (const key of ['devices/u2/manifest.json', 'devices/u1/manifest.json', 'devices/u1/history/2026-10-20.hsync', 'devices/u1/history/2026-10-19.hsync', '.helium-sync-probe-x']) {
    assert.equal((await send('PUT', `/v1/o/${key}`, { body: bytes(3) })).status, 204);
  }
  const root = await send('GET', '/v1/o/');
  assert.equal(root.status, 200);
  assert.equal(root.headers.get('Content-Type'), 'application/json');
  assert.equal(root.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await names(root), ['.helium-sync-probe-x', 'devices']);
  assert.deepEqual(await names(await send('GET', '/v1/o/devices/')), ['u1', 'u2']);
  assert.deepEqual(await names(await send('GET', '/v1/o/devices/u1/')), ['history', 'manifest.json']);
  assert.deepEqual(await names(await send('GET', '/v1/o/devices/u1/history/')), ['2026-10-19.hsync', '2026-10-20.hsync']);
  assert.deepEqual(await names(await send('GET', '/v1/o/devices/u3/')), []);
  assert.deepEqual(await names(await send('GET', '/v1/o/', { token: TOKEN_B })), []);
});

test('GET /v1/o/<key> returns the bytes and ETag; If-None-Match answers 304, weak or in a list; absent is 404', async () => {
  const { send } = rig();
  const body = new TextEncoder().encode('sealed bytes');
  await send('PUT', '/v1/o/devices/u1/manifest.json', { body });
  const res = await send('GET', '/v1/o/devices/u1/manifest.json');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('ETag'), etagOf(body));
  assert.equal(res.headers.get('Content-Type'), 'application/octet-stream');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), body);
  for (const ifNoneMatch of [etagOf(body), `W/${etagOf(body)}`, `"other", ${etagOf(body)}`]) {
    const cached = await send('GET', '/v1/o/devices/u1/manifest.json', { headers: { 'If-None-Match': ifNoneMatch } });
    assert.equal(cached.status, 304, ifNoneMatch);
    assert.equal(cached.headers.get('ETag'), etagOf(body));
  }
  assert.equal((await send('GET', '/v1/o/devices/u1/manifest.json', { headers: { 'If-None-Match': '"other"' } })).status, 200);
  assert.equal((await send('GET', '/v1/o/devices/u2/manifest.json')).status, 404);
});

test('PUT /v1/o/<key> answers 204 with the ETag; the same bytes keep it, other bytes change it', async () => {
  const { send } = rig();
  const first = await send('PUT', '/v1/o/a.hsync', { body: bytes(5, 1) });
  assert.equal(first.status, 204);
  assert.equal(first.headers.get('ETag'), etagOf(bytes(5, 1)));
  assert.equal((await send('PUT', '/v1/o/a.hsync', { body: bytes(5, 1) })).headers.get('ETag'), etagOf(bytes(5, 1)));
  assert.equal((await send('PUT', '/v1/o/a.hsync', { body: bytes(5, 2) })).headers.get('ETag'), etagOf(bytes(5, 2)));
  assert.deepEqual(new Uint8Array(await (await send('GET', '/v1/o/a.hsync')).arrayBuffer()), bytes(5, 2));
  assert.equal((await send('PUT', '/v1/o/empty')).status, 204);
  assert.equal((await send('GET', '/v1/o/empty')).headers.get('ETag'), etagOf(new Uint8Array()));
});

test('DELETE /v1/o/<key> answers 204 whether or not the key exists', async () => {
  const { send } = rig();
  await send('PUT', '/v1/o/devices/u1/manifest.json', { body: bytes(3) });
  assert.equal((await send('DELETE', '/v1/o/devices/u1/manifest.json')).status, 204);
  assert.equal((await send('GET', '/v1/o/devices/u1/manifest.json')).status, 404);
  assert.deepEqual(await names(await send('GET', '/v1/o/')), []);
  assert.equal((await send('DELETE', '/v1/o/devices/u1/manifest.json')).status, 204);
});

test('other paths answer 404 and other methods 405', async () => {
  const { send } = rig();
  assert.equal((await send('GET', '/')).status, 404);
  assert.equal((await send('GET', '/v1/o')).status, 404);
  assert.equal((await send('GET', '/v2/o/a')).status, 404);
  assert.equal((await send('POST', '/v1/o/a')).status, 405);
  assert.equal((await send('HEAD', '/v1/o/a')).status, 405);
  assert.equal((await send('PUT', '/v1/o/devices/')).status, 405);
  assert.equal((await send('DELETE', '/v1/o/')).status, 405);
  assert.equal((await send('POST', '/v1/health')).status, 405);
});

test('every status carries the CORS headers for an extension origin', async () => {
  const limits: Partial<Limits> = { objectBytes: 8, requests: { burst: 100, perSecond: 1 } };
  const main = rig({ vaults: openVaults(':memory:', { bytes: 10, objects: 10 }), limits });
  const broken = rig();
  broken.vaults.close();
  const o = { origin: ORIGIN };
  await main.send('PUT', '/v1/o/k', { ...o, body: bytes(8) });
  const cases: [number, Promise<Response>][] = [
    [200, main.send('GET', '/v1/o/k', o)],
    [200, main.send('GET', '/v1/health', o)],
    [204, main.send('DELETE', '/v1/o/gone', o)],
    [304, main.send('GET', '/v1/o/k', { ...o, headers: { 'If-None-Match': etagOf(bytes(8)) } })],
    [400, main.send('GET', '/v1/o/a%2Fb', o)],
    [401, main.send('GET', '/v1/o/k', { ...o, token: null })],
    [404, main.send('GET', '/v1/o/absent', o)],
    [405, main.send('POST', '/v1/o/k', o)],
    [413, main.send('PUT', '/v1/o/big', { ...o, body: bytes(9) })],
    [507, main.send('PUT', '/v1/o/more', { ...o, body: bytes(3) })],
    [500, broken.send('GET', '/v1/o/k', o)],
    [503, broken.send('GET', '/v1/health', o)],
  ];
  for (const [status, pending] of cases) {
    const res = await pending;
    assert.equal(res.status, status);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN, `${status}`);
    assert.equal(res.headers.get('Vary'), 'Origin', `${status}`);
    assert.equal(res.headers.get('Access-Control-Expose-Headers'), 'ETag, Retry-After', `${status}`);
  }
  main.disk.current = { freeBytes: 0, dataBytes: 0 };
  const full = await main.send('PUT', '/v1/o/new', { ...o, body: bytes(1) });
  assert.equal(full.status, 503);
  assert.equal(full.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  let limited: Response;
  do limited = await main.send('GET', '/v1/o/k', o);
  while (limited.status !== 429);
  assert.equal(limited.headers.get('Access-Control-Allow-Origin'), ORIGIN);
});

test('a web origin gets 403 without CORS headers', async () => {
  const { send } = rig();
  for (const origin of ['https://example.com', 'null', 'chrome-extension://short', `chrome-extension://${'z'.repeat(32)}`, `moz-extension://${'a'.repeat(32)}`, `${ORIGIN}/`]) {
    for (const [method, path] of [['GET', '/v1/o/'], ['OPTIONS', '/v1/o/k'], ['GET', '/v1/health']] as const) {
      const res = await send(method, path, { origin });
      assert.equal(res.status, 403, `${origin} ${method} ${path}`);
      assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
    }
  }
});

test('a request without an Origin is served without CORS headers', async () => {
  const { send } = rig();
  const res = await send('PUT', '/v1/o/k', { body: bytes(1) });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(res.headers.get('Vary'), null);
});

test('an Authorization that is not Bearer and 43 base64url chars is 401', async () => {
  const { send } = rig();
  const bad = [undefined, `Bearer ${'A'.repeat(42)}`, `Bearer ${'A'.repeat(44)}`, `Bearer ${'A'.repeat(42)}=`, `Bearer ${'A'.repeat(42)}+`, `Basic ${'A'.repeat(43)}`, `Bearer  ${'A'.repeat(43)}`, 'A'.repeat(43)];
  for (const authorization of bad) {
    const headers: Record<string, string> = authorization === undefined ? {} : { Authorization: authorization };
    assert.equal((await send('GET', '/v1/o/', { token: null, headers })).status, 401, String(authorization));
    assert.equal((await send('PUT', '/v1/o/k', { token: null, headers, body: bytes(1) })).status, 401, String(authorization));
  }
});

test('a key outside the grammar is 400', async () => {
  const { send } = rig();
  const segment = 'x'.repeat(128);
  const ok = ['a', 'a/b/c/d/e/f', `${segment}/${segment}/${segment}/${'x'.repeat(125)}`, '...', 'A-Z_a.z-0'];
  for (const key of ok) assert.equal((await send('PUT', `/v1/o/${key}`, { body: bytes(1) })).status, 204, key);
  const bad = ['a%20b', 'a%2Fb', '%2E%2E%2Fx', 'a/b/c/d/e/f/g', `${segment}/${segment}/${segment}/${'x'.repeat(126)}`, 'x'.repeat(129), 'a//b', 'a:b', "a'b", 'a~b'];
  for (const key of bad) {
    assert.equal((await send('PUT', `/v1/o/${key}`, { body: bytes(1) })).status, 400, key);
    assert.equal((await send('GET', `/v1/o/${key}`)).status, 400, key);
    assert.equal((await send('GET', `/v1/o/${key}/`)).status, 400, key);
  }
});

test('two tokens never see each other: list, get, and delete are per vault', async () => {
  const { send } = rig();
  await send('PUT', '/v1/o/devices/u1/manifest.json', { body: bytes(2) });
  assert.deepEqual(await names(await send('GET', '/v1/o/devices/', { token: TOKEN_B })), []);
  assert.equal((await send('GET', '/v1/o/devices/u1/manifest.json', { token: TOKEN_B })).status, 404);
  assert.equal((await send('DELETE', '/v1/o/devices/u1/manifest.json', { token: TOKEN_B })).status, 204);
  assert.equal((await send('GET', '/v1/o/devices/u1/manifest.json')).status, 200);
});

test('a body over the cap is 413 with Connection: close, by Content-Length before any read and by stream at the cap', async () => {
  const { send } = rig({ limits: { objectBytes: 16 } });
  const declared = streamOf([bytes(17)]);
  const byHeader = await send('PUT', '/v1/o/k', { headers: { 'Content-Length': '17' }, body: declared.stream });
  assert.equal(byHeader.status, 413);
  assert.equal(byHeader.headers.get('Connection'), 'close');
  assert.equal(declared.pulled.count, 0);
  const streamed = streamOf([bytes(10), bytes(10), bytes(10)]);
  const byStream = await send('PUT', '/v1/o/k', { body: streamed.stream });
  assert.equal(byStream.status, 413);
  assert.ok(streamed.pulled.count < 3, `pulled ${streamed.pulled.count} chunks`);
  assert.equal((await send('GET', '/v1/o/k')).status, 404);
  assert.equal((await send('PUT', '/v1/o/k', { body: streamOf([bytes(8), bytes(8)]).stream })).status, 204);
});

test('a put past the vault quota is 507, by bytes and by count; a replace counts only the difference', async () => {
  const { send } = rig({ vaults: openVaults(':memory:', { bytes: 10, objects: 3 }) });
  const put = async (key: string, length: number) => (await send('PUT', `/v1/o/${key}`, { body: bytes(length) })).status;
  assert.equal(await put('a', 6), 204);
  assert.equal(await put('b', 5), 507);
  assert.equal(await put('b', 4), 204); // 10 of 10 bytes
  assert.equal(await put('a', 6), 204);
  assert.equal(await put('a', 7), 507);
  assert.equal(await put('a', 2), 204); // 6 bytes
  assert.equal(await put('c', 1), 204); // 3 of 3 objects
  assert.equal(await put('d', 1), 507);
  assert.equal(await put('c', 2), 204);
  assert.equal((await send('GET', '/v1/o/b')).status, 200);
  assert.equal((await send('GET', '/v1/o/d')).status, 404);
  assert.equal((await send('PUT', '/v1/o/x', { token: TOKEN_B, body: bytes(10) })).status, 204);
});

test('past its request rate a client gets 429 with Retry-After until the bucket refills; IPv6 counts per /64', async () => {
  const { clock, send } = rig({ limits: { requests: { burst: 2, perSecond: 0.5 } } });
  assert.equal((await send('OPTIONS', '/v1/o/k', { token: null })).status, 204);
  assert.equal((await send('GET', '/v1/o/')).status, 200);
  const limited = await send('GET', '/v1/o/');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('Retry-After'), '2');
  assert.equal((await send('GET', '/v1/o/', { ip: '198.51.100.1' })).status, 200);
  clock.now += 2000;
  assert.equal((await send('GET', '/v1/o/')).status, 200);

  for (const ip of ['2001:db8:1:2::1', '2001:db8:1:2:ffff::9']) assert.equal((await send('GET', '/v1/o/', { ip })).status, 200, ip);
  assert.equal((await send('GET', '/v1/o/', { ip: '2001:0db8:0001:0002:0:0:0:7' })).status, 429);
  assert.equal((await send('GET', '/v1/o/', { ip: '2001:db8:1:3::1' })).status, 200);
});

test('health is exempt from the request rate', async () => {
  const { send } = rig({ limits: { requests: { burst: 1, perSecond: 0.001 } } });
  assert.equal((await send('GET', '/v1/o/')).status, 200);
  assert.equal((await send('GET', '/v1/o/')).status, 429);
  for (let i = 0; i < 5; i++) assert.equal((await send('GET', '/v1/health', { token: null })).status, 200);
});

test('a client creates at most its quota of new vaults, then 429 with Retry-After; puts into existing vaults never count', async () => {
  const { clock, send } = rig({ limits: { newVaults: { burst: 2, perSecond: 0.25 } } });
  const tokens = ['1', '2', '3'].map((c) => c.repeat(43));
  const put = async (token: string, ip = IP) => send('PUT', '/v1/o/k', { token, ip, body: bytes(1) });
  assert.equal((await put(TOKEN_A)).status, 204);
  assert.equal((await put(TOKEN_B)).status, 204);
  for (let i = 0; i < 3; i++) assert.equal((await put(TOKEN_A)).status, 204);
  const limited = await put(tokens[0] ?? '');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('Retry-After'), '4');
  assert.equal((await send('GET', `/v1/o/`, { token: tokens[0] ?? '' })).status, 200);
  assert.equal((await put(tokens[0] ?? '', '198.51.100.1')).status, 204);
  clock.now += 4000;
  assert.equal((await put(tokens[1] ?? '')).status, 204);
});

test('the disk guard answers 503 + Retry-After 300 to puts that grow the data, and to nothing else', async () => {
  const { disk, send } = rig();
  const room = { freeBytes: 2 * GiB, dataBytes: 20 * GiB };
  for (const full of [{ freeBytes: 2 * GiB - 1, dataBytes: 0 }, { freeBytes: 100 * GiB, dataBytes: 20 * GiB + 1 }]) {
    disk.current = room;
    assert.equal((await send('PUT', '/v1/o/k', { body: bytes(4) })).status, 204);
    disk.current = full;
    const refused = await send('PUT', '/v1/o/new', { body: bytes(1) });
    assert.equal(refused.status, 503);
    assert.equal(refused.headers.get('Retry-After'), '300');
    assert.equal((await send('PUT', '/v1/o/k', { body: bytes(5) })).status, 503);
    assert.equal((await send('PUT', '/v1/o/k', { body: bytes(4, 9) })).status, 204);
    assert.equal((await send('PUT', '/v1/o/k', { body: bytes(3) })).status, 204);
    assert.equal((await send('PUT', '/v1/o/k', { body: bytes(4) })).status, 503);
    assert.equal((await send('GET', '/v1/o/k')).status, 200);
    assert.equal((await send('GET', '/v1/o/')).status, 200);
    assert.equal((await send('DELETE', '/v1/o/gone')).status, 204);
  }
  disk.current = room;
  assert.equal((await send('PUT', '/v1/o/new', { body: bytes(1) })).status, 204);
});

test('past its bodies in flight a put answers 503 + Retry-After 5', async () => {
  const { send } = rig({ limits: { bodiesInFlight: 1 } });
  let release = (): void => undefined;
  const slow = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes(1));
      release = () => controller.close();
    },
  });
  const first = send('PUT', '/v1/o/slow', { body: slow });
  const busy = await send('PUT', '/v1/o/other', { body: bytes(1) });
  assert.equal(busy.status, 503);
  assert.equal(busy.headers.get('Retry-After'), '5');
  release();
  assert.equal((await first).status, 204);
  assert.equal((await send('PUT', '/v1/o/other', { body: bytes(1) })).status, 204);
});

test('purgeIdle deletes vaults with no write for the idle window, returns their space, and is idempotent', async (t) => {
  const path = tempDb(t);
  const MiB = 1024 * 1024;
  const first = rig({ vaults: openVaults(path) });
  for (const key of ['h1', 'h2', 'h3', 'h4']) await first.send('PUT', `/v1/o/${key}`, { body: bytes(MiB) });
  first.clock.now += 100 * DAY_MS;
  await first.send('PUT', '/v1/o/manifest.json', { token: TOKEN_B, body: bytes(10) });
  first.vaults.close();
  const before = statSync(path).size;

  const second = rig({ vaults: openVaults(path) });
  second.clock.now = first.clock.now;
  const cutoff = first.clock.now - 99 * DAY_MS;
  assert.equal(second.vaults.purgeIdle(cutoff), 1);
  assert.equal(second.vaults.purgeIdle(cutoff), 0);
  assert.deepEqual(await names(await second.send('GET', '/v1/o/')), []);
  assert.deepEqual(await names(await second.send('GET', '/v1/o/', { token: TOKEN_B })), ['manifest.json']);
  second.vaults.close();
  const after = statSync(path).size;
  assert.ok(after < before - 3 * MiB, `file ${before} -> ${after} bytes`);
});

test('a database file keeps its objects across close and reopen', async (t) => {
  const path = tempDb(t);
  const first = rig({ vaults: openVaults(path) });
  const put = await first.send('PUT', '/v1/o/devices/u1/manifest.json', { body: bytes(5, 3) });
  first.vaults.close();
  const reopened = rig({ vaults: openVaults(path) });
  const res = await reopened.send('GET', '/v1/o/devices/u1/manifest.json');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('ETag'), put.headers.get('ETag'));
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes(5, 3));
  reopened.vaults.close();
});

test('two servers on one database file share one quota (a rolling deploy)', async (t) => {
  const path = tempDb(t);
  const quota = { bytes: 10, objects: 10 };
  const old = rig({ vaults: openVaults(path, quota) });
  const next = rig({ vaults: openVaults(path, quota) });
  assert.equal((await old.send('PUT', '/v1/o/a', { body: bytes(6) })).status, 204);
  assert.deepEqual(await names(await next.send('GET', '/v1/o/')), ['a']);
  assert.equal((await next.send('PUT', '/v1/o/b', { body: bytes(5) })).status, 507);
  assert.equal((await next.send('PUT', '/v1/o/b', { body: bytes(4) })).status, 204);
  assert.equal((await old.send('PUT', '/v1/o/c', { body: bytes(1) })).status, 507);
  old.vaults.close();
  next.vaults.close();
});
