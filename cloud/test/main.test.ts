// The node:http adapter over a real socket: what `handle` cannot see because a Request is already parsed.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request, type IncomingHttpHeaders } from 'node:http';
import { test, type TestContext } from 'node:test';
import { createCloud } from '../src/app.ts';
import type { Limits } from '../src/limits.ts';
import { serve } from '../src/main.ts';
import { openVaults } from '../src/vaults.ts';

const AUTH = { Authorization: `Bearer ${'A'.repeat(43)}` };

type Reply = { readonly status: number; readonly headers: IncomingHttpHeaders; readonly body: string };

/** A served cloud on a free port, closed after the test. */
async function served(t: TestContext, limits: Partial<Limits> = {}): Promise<number> {
  const vaults = openVaults(':memory:');
  const server = serve(createCloud({ vaults, limits }), 0);
  t.after(() => {
    server.closeAllConnections();
    server.close();
    vaults.close();
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return address.port;
}

/** One raw request: the path goes on the wire as written, and `chunks` are sent without a Content-Length. */
async function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, chunks: readonly Buffer[] = []): Promise<Reply> {
  const req = request({ port, method, path, headers });
  for (const chunk of chunks) req.write(chunk);
  if (chunks.length === 0) req.end();
  const [res] = (await once(req, 'response')) as [import('node:http').IncomingMessage];
  let body = '';
  for await (const chunk of res) body += String(chunk);
  return { status: res.statusCode ?? 0, headers: res.headers, body };
}

test('a put and a get round trip over the socket', async (t) => {
  const port = await served(t);
  const put = await raw(port, 'PUT', '/v1/o/devices/u1/manifest.json', { ...AUTH, 'Content-Length': '5' }, [Buffer.from('hello')]);
  assert.equal(put.status, 204);
  const got = await raw(port, 'GET', '/v1/o/devices/u1/manifest.json', AUTH);
  assert.equal(got.status, 200);
  assert.equal(got.body, 'hello');
  assert.equal(got.headers.etag, put.headers.etag);
});

test('a request target the URL parser would rewrite is 400, so no key has a second spelling', async (t) => {
  const port = await served(t);
  assert.equal((await raw(port, 'PUT', '/v1/o/b', { ...AUTH, 'Content-Length': '1' }, [Buffer.from('x')])).status, 204);
  for (const path of ['/v1/o/a/../b', '/v1/o/./b', '/v1/o/a/%2e%2e/b', '/v1/o/a\\..\\b', 'http://cloud/v1/o/b']) {
    assert.equal((await raw(port, 'GET', path, AUTH)).status, 400, path);
  }
  assert.equal((await raw(port, 'GET', '/v1/o/b', AUTH)).status, 200);
});

test('a body streamed past the cap gets its 413 over the socket, which then closes', async (t) => {
  const port = await served(t, { objectBytes: 16 });
  const reply = await raw(port, 'PUT', '/v1/o/k', AUTH, [Buffer.alloc(10), Buffer.alloc(10)]);
  assert.equal(reply.status, 413);
  assert.equal(reply.headers.connection, 'close');
  assert.equal((await raw(port, 'GET', '/v1/o/k', AUTH)).status, 404);
});

test('the client is the last X-Forwarded-For entry, else the socket peer', async (t) => {
  const port = await served(t, { requests: { burst: 1, perSecond: 0.001 } });
  assert.equal((await raw(port, 'GET', '/v1/o/', { ...AUTH, 'X-Forwarded-For': '192.0.2.1, 198.51.100.1' })).status, 200);
  assert.equal((await raw(port, 'GET', '/v1/o/', { ...AUTH, 'X-Forwarded-For': '192.0.2.2, 198.51.100.1' })).status, 429);
  assert.equal((await raw(port, 'GET', '/v1/o/', { ...AUTH, 'X-Forwarded-For': '198.51.100.1, 198.51.100.2' })).status, 200);
  assert.equal((await raw(port, 'GET', '/v1/o/', AUTH)).status, 200);
  assert.equal((await raw(port, 'GET', '/v1/o/', AUTH)).status, 429);
});
