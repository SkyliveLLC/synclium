// Focused checks on the pure modules: each one names a defect the engine suites would only catch indirectly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDeviceId, isItemId, type DeviceId, type Hlc, type ItemId, type Live, type Replica } from '../src/model.ts';
import { ackedOf, collectGarbage, diffLive, entryOf, foldLocalChanges, massDelete, materialize, mergeReplicas, tick } from '../src/crdt.ts';
import { ROOTS, between, bookmarks, isPosition, placeChildren, type Bookmark, type Position } from '../src/bookmarks.ts';
import { history, visitKey } from '../src/history.ts';
import {
  FORMAT_VERSION,
  encodeLogShard,
  encodeManifest,
  encodeStateFile,
  keys,
  open,
  openManifest,
  parseLogShard,
  parseManifest,
  parseRel,
  parseStateFile,
  seal,
  sealManifest,
  type Manifest,
  type RelName,
} from '../src/store-format.ts';
import { cipherFor, formatSyncKey, mintSyncKey, parseSyncKey } from '../src/sync-key.ts';

const dev = (n: number): DeviceId => {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  if (!isDeviceId(id)) throw new Error(id);
  return id;
};
const item = (s: string): ItemId => {
  if (!isItemId(s)) throw new Error(s);
  return s;
};
const pos = (s: string): Position => {
  if (!isPosition(s)) throw new Error(s);
  return s;
};
const registerRelOf = (name: string): RelName => {
  const parsed = parseRel(name);
  if (parsed === null) throw new Error(name);
  return parsed.rel;
};
const A = dev(1);
const B = dev(2);
const url = (title: string, parent: ItemId, p: string, href = 'https://e/x'): Bookmark => ({ kind: 'url', title, url: href, location: { parent, pos: pos(p) } });
const folder = (title: string, parent: ItemId, p: string): Bookmark => ({ kind: 'folder', title, location: { parent, pos: pos(p) } });
const stampAt = (wall: number, self: DeviceId, counter = 0): Hlc => tick({ wall, counter: counter - 1 }, wall, null, self).stamp;

test('hlc: a stamp minted after seeing a peer stamp from the future still sorts after it, and consecutive stamps strictly increase', () => {
  const future = stampAt(2_000_000, B);
  const first = tick({ wall: 0, counter: 0 }, 1_000_000, future, A);
  assert.ok(first.stamp > future, 'a slow clock cannot lose to a stamp it has seen');
  const second = tick(first.state, 1_000_000, future, A);
  assert.ok(second.stamp > first.stamp);
  const later = tick(second.state, 2_000_001, null, A);
  assert.ok(later.stamp > second.stamp, 'wall time dominates the counter in string order');
});

test('fold: a half-applied remote value is not re-stamped as a local edit, a real edit is, and a local removal becomes a tombstone', () => {
  const id = item('n1');
  const gone = item('n2');
  const s0 = stampAt(1, B);
  const merged = new Map([
    [id, entryOf(url('remote-title', ROOTS.bar, 'a'), s0)],
    [gone, entryOf(url('gone', ROOTS.bar, 'b'), s0)],
  ]);
  const applied: Live<Bookmark> = new Map([
    [id, url('old-title', ROOTS.bar, 'a')],
    [gone, url('gone', ROOTS.bar, 'b')],
  ]);
  const s1 = stampAt(2, A);
  const halfApplied = foldLocalChanges(merged, applied, new Map([[id, url('remote-title', ROOTS.bar, 'a')]]), s1);
  assert.equal(halfApplied.get(id)?.fields.title[1], s0, 'observed equals merged: no stamp even though it differs from applied');
  assert.deepEqual(halfApplied.get(gone)?.deleted, [true, s1], 'absent from the profile but applied: tombstoned');
  const edited = foldLocalChanges(merged, applied, new Map([[id, url('my-title', ROOTS.bar, 'a')]]), s1);
  const entry = edited.get(id);
  if (entry?.kind !== 'url') throw new Error('url entry expected');
  assert.deepEqual(entry.fields.title, ['my-title', s1]);
  assert.equal(entry.fields.url[1], s0, 'untouched fields keep their stamps');
});

test('fold: an item the profile holds but never applied keeps the merged values, and a merged-deleted item takes no field stamps', () => {
  const id = item('adopted');
  const s0 = stampAt(1, B);
  const merged = new Map([[id, entryOf(url('t', ROOTS.bar, 'm'), s0)]]);
  const observed = new Map([[id, url('t', ROOTS.bar, 'zz')]]);
  const folded = foldLocalChanges(merged, new Map<ItemId, Bookmark>(), observed, stampAt(2, A));
  const kept = folded.get(id);
  assert.ok(kept !== undefined);
  assert.equal(kept.fields.location[0].pos, 'm', 'the locally minted position is not a move');
  const deleted = new Map([[id, { ...entryOf(url('t', ROOTS.bar, 'm'), s0), deleted: [true, s0] as const }]]);
  const doomed = foldLocalChanges(deleted, new Map([[id, url('t', ROOTS.bar, 'm')]]), new Map([[id, url('t', ROOTS.bar, 'q')]]), stampAt(2, A));
  assert.equal(doomed.get(id)?.fields.location[1], s0, 'delete beats a concurrent position change');
});

test('gc: a tombstone goes once every live ack covers it, except while a live record still references it', () => {
  const dead = item('dead-folder');
  const child = item('child');
  const sDel = stampAt(5, A);
  const tombstone = { ...entryOf(folder('F', ROOTS.bar, 'a'), stampAt(1, A)), deleted: [true, sDel] as const };
  const replica = new Map([
    [dead, tombstone],
    [child, entryOf(url('c', dead, 'a'), stampAt(1, A))],
  ]);
  const covering = [new Map([[A, sDel]]), new Map([[A, sDel]])];
  const pinned = collectGarbage(replica, covering, bookmarks.references);
  assert.equal(pinned.has(dead), true, 'referenced by a live child: kept so normalize can re-home the child');
  const orphanless = new Map([[dead, tombstone]]);
  assert.equal(collectGarbage(orphanless, covering, bookmarks.references).has(dead), false, 'unreferenced and acked by all: dropped');
  const lagging = [new Map([[A, sDel]]), new Map([[A, stampAt(4, A)]])];
  assert.equal(collectGarbage(orphanless, lagging, bookmarks.references).has(dead), true, 'one live device has not acked the delete: kept');
  assert.equal(ackedOf(collectGarbage(orphanless, covering, bookmarks.references), new Map([[A, sDel]])).get(A), sDel, 'acked never drops below the mark GC removed');
});

test('merge is commutative and idempotent, and the newest register wins per field', () => {
  const id = item('n');
  const s1 = stampAt(1, A);
  const a: Replica<Bookmark> = new Map([
    [id, { kind: 'url', fields: { title: ['A', stampAt(3, A)], url: ['https://e/x', s1], location: [{ parent: ROOTS.bar, pos: pos('a') }, s1] }, deleted: [false, s1] }],
  ]);
  const b = new Map([[id, entryOf(url('B', ROOTS.other, 'b'), stampAt(2, B))]]);
  const ab = mergeReplicas([a, b]);
  const ba = mergeReplicas([b, a]);
  assert.deepEqual(ab, ba);
  assert.deepEqual(mergeReplicas([ab, a, b]), ab);
  assert.equal(ab.get(id)?.fields.title[0], 'A', 'title: A stamped later');
  assert.equal(ab.get(id)?.fields.location[0]?.parent, ROOTS.other, 'location: B stamped later');
});

test('mass-delete guard: thresholds on fraction, minimum size, and the empty read', () => {
  const live = (n: number): Live<Bookmark> => new Map(Array.from({ length: n }, (_, i) => [item(`i${i}`), url(`t${i}`, ROOTS.bar, 'a')]));
  const limits = { minItems: 20, fraction: 0.5 };
  const keep = (from: Live<Bookmark>, n: number) => new Map([...from].slice(0, n));
  assert.equal(massDelete(live(20), keep(live(20), 10), limits, true), null, 'exactly half is not more than half');
  assert.deepEqual(massDelete(live(20), keep(live(20), 9), limits, true), { removed: 11, of: 20 });
  assert.equal(massDelete(live(10), keep(live(10), 1), limits, true), null, 'below minItems the fraction does not apply');
  assert.deepEqual(massDelete(live(10), new Map(), limits, true), { removed: 10, of: 10 }, 'an empty bookmark read of a non-empty profile always trips');
  assert.equal(massDelete(live(3), new Map(), limits, false), null, 'emptying a small list on purpose does not');
  assert.equal(massDelete(null, new Map(), limits, true), null, 'first join never trips');
});

test('positions: between() keys are strictly ordered with no trailing zero, and placeChildren re-mints only what moved', () => {
  let lo = '';
  const keys: Position[] = [];
  for (let i = 0; i < 50; i++) {
    const k = between(lo, null);
    assert.ok(k > lo && !k.endsWith('0'));
    keys.push(k);
    lo = k;
  }
  const mid = between(keys[0] ?? '', keys[1] ?? null);
  assert.ok(mid > (keys[0] ?? '') && mid < (keys[1] ?? ''));

  const ia = item('a');
  const ib = item('b');
  const ic = item('c');
  const id = item('d');
  const ids = [ia, ib, ic, id];
  const first = placeChildren(new Map([[ROOTS.bar, ids]]), null);
  const previous: Live<Bookmark> = new Map(ids.map((i) => [i, url(i, ROOTS.bar, first.get(i)?.pos ?? '')]));
  const again = placeChildren(new Map([[ROOTS.bar, ids]]), previous);
  assert.deepEqual(again, first, 'an unchanged folder keeps every position');
  const moved = placeChildren(new Map([[ROOTS.bar, [id, ia, ib, ic]]]), previous);
  for (const i of [ia, ib, ic]) assert.equal(moved.get(i)?.pos, first.get(i)?.pos, `${i} did not move and keeps its key`);
  assert.ok((moved.get(id)?.pos ?? '') < (first.get(ia)?.pos ?? ''), 'd moved to the front and got a key before a');
});

test('normalize: a move cycle is broken at the smallest id and an orphan is re-homed through dead ancestors', () => {
  const f1 = item('f1');
  const f2 = item('f2');
  const orphan = item('orphan');
  const g1 = item('g1');
  const g2 = item('g2');
  const live: Live<Bookmark> = new Map([
    [f1, folder('F1', f2, 'a')],
    [f2, folder('F2', f1, 'a')],
    [orphan, url('o', g1, 'a')],
  ]);
  const dead: Live<Bookmark> = new Map([
    [g1, folder('G1', g2, 'a')],
    [g2, folder('G2', ROOTS.mobile, 'a')],
  ]);
  const out = bookmarks.normalize(live, dead);
  assert.equal(out.get(f1)?.location.parent, ROOTS.other, 'smallest cycle member goes to Other');
  assert.equal(out.get(f2)?.location.parent, f1, 'the other member keeps its parent');
  assert.equal(out.get(orphan)?.location.parent, ROOTS.mobile, 'nearest live ancestor through two dead folders');
  const lost = bookmarks.normalize(new Map([[orphan, url('o', g1, 'a')]]), new Map());
  assert.equal(lost.get(orphan)?.location.parent, ROOTS.other, 'no known ancestor: Other');
});

test('adopt: twins pair in order, known ids anchor without re-mapping, and new items are placed among synced neighbours', () => {
  const l1 = item('l1');
  const l2 = item('l2');
  const l3 = item('l3');
  const s1 = item('s1');
  const s2 = item('s2');
  const known = item('known');
  const local: Live<Bookmark> = new Map([
    [l1, url('twin', ROOTS.bar, '3')],
    [l2, url('twin', ROOTS.bar, '6')],
    [known, url('k', ROOTS.bar, '9')],
    [l3, url('fresh', ROOTS.bar, 'c')],
  ]);
  const synced: Live<Bookmark> = new Map([
    [s1, url('twin', ROOTS.bar, 'a')],
    [s2, url('twin', ROOTS.bar, 'b')],
    [known, url('k', ROOTS.bar, 'd')],
  ]);
  const unclaimed = new Map([...synced].filter(([id]) => id !== known));
  const { live, aliases } = bookmarks.adopt({ local, synced, unclaimed, isKnown: (id) => id === known });
  assert.deepEqual([...aliases], [[l1, s1], [l2, s2]], 'twins pair in display order');
  assert.equal(live.has(known), true);
  const freshPos = live.get(l3)?.location.pos ?? '';
  assert.ok(freshPos > 'd', 'the new item is placed after the synced neighbour it follows, not from a fresh mint');
  assert.equal(live.get(s1)?.location.pos, 'a', 'adopted items take synced positions');
});

test('store format: a sealed file opens; a byte off, a hash off, or a truncation reads as not-yet', async () => {
  const cipher = await cipherFor(mintSyncKey());
  const at = keys.file(A, registerRelOf('bookmarks.hsync'));
  const sealed = await seal({ hello: 'world' }, cipher, at);
  assert.deepEqual(await open(sealed.bytes, cipher, at, sealed.entry), { kind: 'ok', body: { hello: 'world' } });
  assert.equal((await open(sealed.bytes.subarray(0, sealed.bytes.length - 1), cipher, at, sealed.entry)).kind, 'not-yet');
  const flipped = new Uint8Array(sealed.bytes);
  flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 1;
  assert.equal((await open(flipped, cipher, at, sealed.entry)).kind, 'not-yet');
  assert.equal((await open(sealed.bytes, cipher, at, { ...sealed.entry, hash: '0'.repeat(64) })).kind, 'not-yet');
});

test('encryption: no plaintext in the bytes, another key reads as other-key, and a tag that fails reads as not-yet', async () => {
  const key = mintSyncKey();
  const cipher = await cipherFor(key);
  const at = keys.file(A, registerRelOf('bookmarks.hsync'));
  const sealed = await seal({ title: 'secret-bookmark-title' }, cipher, at);
  assert.equal(new TextDecoder().decode(sealed.bytes).includes('secret-bookmark-title'), false, 'the body is not readable without the key');
  assert.equal((await cipherFor(key)).keyId, cipher.keyId, 'the key id is a function of the key');
  assert.deepEqual(await open(sealed.bytes, await cipherFor(mintSyncKey()), at, null), { kind: 'other-key' });
  // Another device's file copied into A's folder, under the same key: the path is authenticated.
  const elsewhere = keys.file(B, registerRelOf('bookmarks.hsync'));
  assert.equal((await open(sealed.bytes, cipher, elsewhere, null)).kind, 'not-yet', 'a file moved to another path does not open');
  // A forged header claiming our key over someone else's ciphertext, without a manifest to vouch: the tag fails.
  const body = sealed.bytes.subarray(sealed.bytes.indexOf(0x0a) + 1);
  const forged = new Uint8Array([...new TextEncoder().encode(`{"codec":"a256gcm-gzip-json","formatVersion":${FORMAT_VERSION},"key":"${cipher.keyId}","magic":"helium-sync","x":1}\n`), ...body]);
  assert.equal((await open(forged, cipher, at, null)).kind, 'not-yet', 'the header is authenticated');
});

test('sync key: format and parse round-trip, typing slips are forgiven, and anything else is refused', () => {
  const key = mintSyncKey();
  const shown = formatSyncKey(key);
  assert.match(shown, /^HSK(-[0-9A-HJKMNP-TV-Z]{4}){13}$/);
  assert.equal(parseSyncKey(shown), key);
  assert.equal(parseSyncKey(shown.toLowerCase().replace(/-/g, ' ')), key, 'case and spaces');
  assert.equal(parseSyncKey(key), key, 'without prefix or dashes');
  assert.equal(parseSyncKey(` ${shown.replace(/0/g, 'O').replace(/1/g, 'l')}\n`), key, 'O for 0 and l for 1');
  assert.equal(parseSyncKey(shown.slice(0, -1)), null, 'a digit short');
  assert.equal(parseSyncKey(`${shown}0`), null, 'a digit long');
  assert.equal(parseSyncKey(shown.replace(/.$/, 'U')), null, 'U is not a digit');
  // 256 bits fill 51 digits and one bit of the 52nd, so the last digit is 0 or G; 1 sets a pad bit.
  assert.match(key, /[0G]$/);
  assert.equal(parseSyncKey(key.slice(0, -1) + '1'), null, 'nonzero pad bits are not canonical');
});

test('manifest: sealed for its own path, foreign rels are dropped, a device mismatch rejects it, and rel parsing is strict', async () => {
  const m: Manifest = {
    formatVersion: FORMAT_VERSION,
    device: A,
    name: 'Mac',
    platform: 'mac',
    app: { name: 'helium-sync', version: '1' },
    seq: 3,
    lastSeen: 42,
    files: new Map<RelName, { hash: string; bytes: number }>([
      [parseRel('bookmarks.hsync')!.rel, { hash: 'a'.repeat(64), bytes: 1 }],
      [parseRel('history/2026-10-06.hsync')!.rel, { hash: 'b'.repeat(64), bytes: 2 }],
    ]),
  };
  const cipher = await cipherFor(mintSyncKey());
  const sealed = await sealManifest(m, cipher);
  assert.deepEqual(await openManifest(sealed, A, cipher), { kind: 'ok', manifest: m });
  assert.equal((await openManifest(sealed, B, cipher)).kind, 'not-yet', 'a manifest copied into another device\'s folder does not open');
  const body = encodeManifest(m);
  assert.equal(parseManifest(body, B), null, 'a manifest naming another device is not trusted');
  const withForeign = JSON.parse(JSON.stringify(body)) as { files: Record<string, unknown> };
  withForeign.files['../../etc/passwd'] = { hash: 'c'.repeat(64), bytes: 3 };
  withForeign.files['bookmarks.hsync (conflicted copy)'] = { hash: 'c'.repeat(64), bytes: 3 };
  assert.equal(parseManifest(withForeign, A)?.files.size, 2, 'foreign names never become fetch targets');
  assert.equal(parseRel('History/2026-10-06.hsync'), null);
  assert.equal(parseRel('history/2026-10-6.hsync'), null);
});

test('log shard: javascript: urls and events outside the day are dropped without losing the shard', () => {
  const day = parseRel('history/2026-10-06.hsync');
  if (day?.kind !== 'shard') throw new Error('rel');
  const inDay = Date.UTC(2026, 9, 6, 10);
  const body = encodeLogShard({
    device: A,
    type: 'history',
    typeVersion: 1,
    day: day.day,
    events: [
      { url: 'https://ok.example/', title: 'ok', t: inDay },
      { url: 'javascript:alert(1)', title: 'xss', t: inDay + 1 },
      { url: 'https://late.example/', title: 'late', t: inDay + 2 * 86_400_000 },
    ],
  });
  const parsed = parseLogShard(body, history, { device: A, day: day.day });
  assert.equal(parsed.kind, 'ok');
  if (parsed.kind === 'ok') assert.deepEqual(parsed.file.events.map((e) => e.url), ['https://ok.example/']);
  assert.equal(parseLogShard(body, history, { device: B, day: day.day }).kind, 'invalid', 'wrong folder');
  assert.equal(history.parseEvent({ url: 'file:///etc/passwd', title: '', t: 1 }), null);
  const micros = 1_700_000_000_000_123;
  assert.ok(visitKey('https://a/', micros / 1000).endsWith(`\u0000${micros}`), 'a Chromium microsecond time read as fractional ms keys back to the same integer');
});

test('state file: a newer type version is refused, a bad entry drops alone, and the rest round-trips', () => {
  const good = item('good');
  const bad = item('bad');
  const s = stampAt(1, A);
  const file = {
    device: A,
    type: 'bookmarks',
    typeVersion: 1,
    seq: 1,
    writtenAt: s,
    acked: new Map([[A, s]]),
    replica: new Map([
      [good, entryOf(url('g', ROOTS.bar, 'a'), s)],
      [bad, entryOf(url('b', ROOTS.bar, 'a'), s)],
    ]),
  };
  const body = encodeStateFile(file);
  const parsed = parseStateFile(body, bookmarks, { device: A });
  assert.equal(parsed.kind, 'ok');
  if (parsed.kind === 'ok') assert.deepEqual(parsed.file, file);
  const raw: unknown = JSON.parse(JSON.stringify(body));
  if (typeof raw !== 'object' || raw === null || !('replica' in raw) || !('typeVersion' in raw)) throw new Error('shape');
  const replicaRaw: unknown = raw.replica;
  if (typeof replicaRaw !== 'object' || replicaRaw === null || !(bad in replicaRaw)) throw new Error('shape');
  const badRaw: unknown = Reflect.get(replicaRaw, bad);
  if (typeof badRaw !== 'object' || badRaw === null || !('fields' in badRaw) || typeof badRaw.fields !== 'object' || badRaw.fields === null) throw new Error('shape');
  Reflect.set(badRaw.fields, 'location', [{ parent: 'nope', pos: '' }, s]);
  const partial = parseStateFile(raw, bookmarks, { device: A });
  assert.equal(partial.kind === 'ok' && [...partial.file.replica.keys()].join(), good, 'the malformed entry drops, the good one stays');
  Reflect.set(raw, 'typeVersion', 2);
  assert.deepEqual(parseStateFile(raw, bookmarks, { device: A }), { kind: 'newer-type-version', version: 2 });
});

test('diffLive and materialize agree on adds, updates, and removes', () => {
  const a = item('a');
  const b = item('b');
  const from: Live<Bookmark> = new Map([
    [a, url('a', ROOTS.bar, 'a')],
    [b, url('b', ROOTS.bar, 'b')],
  ]);
  const to: Live<Bookmark> = new Map([
    [a, url('a2', ROOTS.bar, 'a')],
    [item('c'), url('c', ROOTS.bar, 'c')],
  ]);
  assert.deepEqual(
    diffLive(from, to).map((c) => `${c.op}:${c.id}`),
    ['update:a', 'add:c', 'remove:b'],
  );
  const s = stampAt(1, A);
  const replica = new Map([
    [a, entryOf(url('a', ROOTS.bar, 'a'), s)],
    [b, { ...entryOf(url('b', ROOTS.bar, 'b'), s), deleted: [true, s] as const }],
  ]);
  assert.deepEqual([...materialize(replica, bookmarks.normalize).keys()], [a], 'tombstones are not live');
});
