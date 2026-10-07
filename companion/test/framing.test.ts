import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frame, readFrames } from '../src/framing.ts';

async function collect(chunks: readonly Uint8Array[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const message of readFrames(chunks)) out.push(message);
  return out;
}

test('frames round-trip across arbitrary chunk boundaries', async () => {
  const messages = [{ kind: 'hello' }, { kind: 'read', profile: 'Profile 1', note: 'ünïcödé ✓' }];
  const bytes = Buffer.concat(messages.map(frame));
  assert.equal(bytes.readUInt32LE(0), Buffer.byteLength(JSON.stringify(messages[0])));
  // One byte at a time is the worst split.
  assert.deepEqual(await collect([...bytes].map((b) => Uint8Array.of(b))), messages);
});

test('a frame that is not JSON yields an Error and reading continues', async () => {
  const body = Buffer.from('{oops');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  const [bad, good] = await collect([Buffer.concat([header, body, frame({ kind: 'hello' })])]);
  assert.ok(bad instanceof Error);
  assert.deepEqual(good, { kind: 'hello' });
});
