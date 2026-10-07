// The log model through the engine: owner-only shards, the echo rule, retention, re-derive after a local
// delete, and a resumable newest-first backfill.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAY_MS, dayOf, shiftDay } from '../src/model.ts';
import { history } from '../src/history.ts';
import { keys, shardRel } from '../src/store-format.ts';
import { World, expireAfter, openBody, readManifest, syncedPair } from './support/harness.ts';
import { ground } from './support/ground.ts';
import { visitsOver } from './support/fake-history.ts';

const REDERIVE = { rederiveHistory: 1, applyDeletions: 0 };

async function shardUrls(world: World, device: string, day: string): Promise<readonly string[]> {
  const path = `devices/${device}/history/${day}.hsync`;
  const file = world.cloud.files.get(path);
  if (file === undefined) return [];
  const body = await openBody(file.data, path);
  if (typeof body !== 'object' || body === null || !('events' in body) || !Array.isArray(body.events)) throw new Error('bad shard');
  return body.events.map((e: unknown) => (typeof e === 'object' && e !== null && 'url' in e && typeof e.url === 'string' ? e.url : ''));
}

test('owner-only shards: each device publishes only its own visits, and peers index them under the author', async () => {
  const world = new World('icloud');
  const { x, y } = await syncedPair(world);
  for (const v of visitsOver(world.clock.now, 2, 3, 'x.example')) x.history.add(v);
  for (const v of visitsOver(world.clock.now, 2, 2, 'y.example')) y.history.add(v);
  await x.cycle(undefined, REDERIVE);
  await y.cycle(undefined, REDERIVE);
  await x.cycle();
  const today = dayOf(world.clock.now);
  const xShard = await shardUrls(world, x.device, today);
  assert.equal(xShard.length, 3);
  assert.ok(xShard.every((u) => u.startsWith('https://x.example/')), 'X\'s shard holds only X\'s visits');
  assert.ok((await shardUrls(world, y.device, today)).every((u) => u.startsWith('https://y.example/')), 'Y\'s shard holds only Y\'s visits');
  assert.equal(y.sink.visitsFrom(x.device).length, 6, 'Y indexed X\'s two days');
  assert.equal(x.sink.visitsFrom(y.device).length, 4, 'X indexed Y\'s two days');
  assert.equal(y.sink.indexed().has(y.device), false, 'a device never indexes itself');
});

test('echo rule: a peer visit that appears in the local profile is not republished as this device\'s own', async () => {
  const world = new World('icloud');
  const { x, y } = await syncedPair(world);
  const recent = y.history.add({ url: 'https://y.example/recent', title: 'recent', t: world.clock.now - 30_000 });
  const old = y.history.add({ url: 'https://y.example/old', title: 'old', t: world.clock.now - 3 * DAY_MS });
  await y.cycle(undefined, REDERIVE);
  await x.cycle();
  assert.equal(x.sink.visitsFrom(y.device).length, 2, 'X indexed both of Y\'s visits');
  // The companion writes both into X's profile at their real times.
  x.history.add(recent);
  x.history.add(old);
  x.history.add({ url: 'https://x.example/own', title: 'own', t: world.clock.now - 20_000 });
  world.clock.tick(1000);
  await x.cycle(undefined, REDERIVE);
  const today = dayOf(world.clock.now);
  assert.deepEqual(await shardUrls(world, x.device, today), ['https://x.example/own'], 'the scan dropped the echoed recent visit');
  assert.deepEqual(await shardUrls(world, x.device, dayOf(old.t)), [], 'the derive walk dropped the echoed old visit');
  await y.cycle();
  assert.equal(y.sink.visitsFrom(x.device).length, 1, 'Y sees only X\'s own visit');
});

test('retention: day 91 is never published, and a day that ages out leaves the manifest, the store, and peers\' indexes', async () => {
  const world = new World('icloud');
  const { x, y } = await syncedPair(world);
  for (const v of visitsOver(world.clock.now, 92, 1, 'x.example')) x.history.add(v);
  await x.cycle(undefined, REDERIVE);
  const today = dayOf(world.clock.now);
  const oldestKept = shiftDay(today, -(history.retentionDays - 1));
  const manifest = async () => {
    const parsed = await readManifest(world.cloud.files.get(keys.manifest(x.device))?.data, x.device);
    if (parsed === null) throw new Error('no manifest');
    return parsed;
  };
  assert.equal([...(await manifest()).files.keys()].filter((rel) => rel.startsWith('history/')).length, history.retentionDays, 'exactly 90 days published');
  assert.equal((await manifest()).files.has(shardRel(history, shiftDay(oldestKept, -1))), false, 'day 91 is not published');
  await y.cycle();
  assert.equal(y.sink.visitsFrom(x.device).length, history.retentionDays);
  world.clock.tick(DAY_MS);
  await x.cycle();
  assert.equal((await manifest()).files.has(shardRel(history, oldestKept)), false, 'the aged-out day left the manifest');
  assert.equal(world.cloud.files.has(keys.file(x.device, shardRel(history, oldestKept))), false, 'and its file left the store');
  assert.equal(x.logLocal.days().has(oldestKept), false, 'and the owner forgot it locally');
  await y.cycle();
  assert.equal(y.sink.indexed().get(x.device)?.has(oldestKept), false, 'the peer dropped it from the index');
  assert.equal(y.sink.visitsFrom(x.device).length, history.retentionDays - 1);
});

test('a local delete plus a rederive ask removes the visit from the owner\'s shard, peers drop it, and the ask acts once', async () => {
  const world = new World('icloud');
  const { x, y } = await syncedPair(world);
  const visits = visitsOver(world.clock.now, 1, 4, 'x.example');
  for (const v of visits) x.history.add(v);
  await x.cycle(undefined, REDERIVE);
  await y.cycle();
  assert.equal(y.sink.visitsFrom(x.device).length, 4);
  const doomed = visits[1];
  assert.ok(doomed !== undefined);
  assert.equal(x.history.remove((v) => v.url === doomed.url && v.t === doomed.t), 1);
  world.clock.tick(1000);
  const unaware = await x.cycle();
  assert.equal((await shardUrls(world, x.device, dayOf(world.clock.now))).length, 4, 'without an ask the scan cannot see a deletion');
  assert.equal(unaware.kind, 'cycle');
  const asked = await x.cycle(undefined, { rederiveHistory: 2, applyDeletions: 0 });
  assert.equal((await shardUrls(world, x.device, dayOf(world.clock.now))).length, 3, 'the re-derived day lacks the deleted visit');
  assert.equal(asked.kind === 'cycle' && asked.history.kind === 'synced' && asked.history.deriveDaysLeft, 0);
  await y.cycle();
  assert.equal(y.sink.visitsFrom(x.device).length, 3, 'the peer replaced the day whole');
  const walkedAt = x.local.state()?.history.lastWalk;
  world.clock.tick(1000);
  await x.cycle(undefined, { rederiveHistory: 2, applyDeletions: 0 });
  assert.equal(x.local.state()?.history.lastWalk, walkedAt, 'the same ask count does not start another walk');
});

test('backfill walks newest day first and resumes across budget cuts to the same days an unbounded run derives', async () => {
  const days = 10;
  const build = async (world: World) => {
    const x = world.add('X', { browser: ground() });
    await x.setup();
    for (const v of visitsOver(world.clock.now, days, 2, 'x.example')) x.history.add(v);
    return x;
  };
  const unbounded = await build(new World('icloud'));
  await unbounded.cycle();
  const expected = [...unbounded.logLocal.days().keys()].sort();
  assert.equal(expected.length, days);

  const world = new World('icloud');
  const x = await build(world);
  x.pull();
  const first = await x.sync(expireAfter(3));
  assert.equal(first.kind === 'cycle' && first.complete, false, 'three units do not finish a 90-day walk');
  const derived = [...x.logLocal.days().keys()].sort();
  assert.ok(derived.length >= 1 && derived.length < days, `a prefix of the days was derived (${derived.length})`);
  const newest = expected.slice(expected.length - derived.length);
  assert.deepEqual(derived, newest, 'the derived days are the newest ones');
  if (first.kind === 'cycle' && first.history.kind === 'synced') assert.ok(first.history.deriveDaysLeft > 0, 'the report shows the walk continuing');
  let wakes = 1;
  for (;;) {
    const report = await x.sync(expireAfter(3));
    wakes++;
    if (report.kind === 'cycle' && report.complete) break;
    if (wakes > 200) assert.fail('the walk never completed');
  }
  assert.ok(wakes > 10, `the walk needed several wakes (${wakes})`);
  assert.deepEqual([...x.logLocal.days().keys()].sort(), expected, 'every day arrived');
  assert.deepEqual(
    [...x.logLocal.days()].map(([d, v]) => [d, v.length]),
    [...unbounded.logLocal.days()].map(([d, v]) => [d, v.length]),
    'with the same visits per day as the unbounded run',
  );
  x.push();
  const parsed = await readManifest(world.cloud.files.get(keys.manifest(x.device))?.data, x.device);
  assert.equal([...(parsed?.files.keys() ?? [])].filter((rel) => rel.startsWith('history/')).length, days, 'all days published');
});
