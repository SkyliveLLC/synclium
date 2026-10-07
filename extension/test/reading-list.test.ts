// The reading list as a second register type: ids from urls, so two devices adding one page make one entry,
// and read state and titles merge like any register field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, syncedPair, type Device } from './support/harness.ts';
import { readingItemId, readingList } from '../src/reading-list.ts';
import type { SyncReport } from '../src/engine.ts';

const cycleReport = async (d: Device): Promise<Extract<SyncReport, { kind: 'cycle' }>> => {
  const report = await d.cycle();
  if (report.kind !== 'cycle') throw new Error(`expected a cycle, got ${report.kind}`);
  return report;
};

test('entries, read state, renames, and removals cross between devices', async () => {
  const world = new World('icloud');
  const { x, y } = await syncedPair(world);
  x.readingList.add('https://a.example/', 'A');
  x.readingList.add('https://b.example/', 'B');
  await world.converge();
  assert.equal(y.readingList.render(), 'https://a.example/ | A\nhttps://b.example/ | B');

  await y.readingList.updateEntry({ url: 'https://a.example/', hasBeenRead: true });
  await x.readingList.updateEntry({ url: 'https://b.example/', title: 'B, renamed' });
  await world.converge();
  assert.equal(x.readingList.render(), 'https://a.example/ | A (read)\nhttps://b.example/ | B, renamed');
  assert.equal(y.readingList.render(), x.readingList.render());

  await x.readingList.removeEntry({ url: 'https://a.example/' });
  await world.converge();
  assert.equal(y.readingList.render(), 'https://b.example/ | B, renamed', 'the removal reached Y');
});

test('two devices adding the same page before syncing end with one entry and no interrupted apply', async () => {
  const world = new World('icloud');
  const { x, y } = await syncedPair(world);
  x.readingList.add('https://same.example/', 'from X');
  y.readingList.add('https://same.example/', 'from Y');
  await world.converge();
  assert.equal(x.readingList.entries.size, 1);
  assert.equal(x.readingList.render(), y.readingList.render(), 'one title won on both');
  const report = await cycleReport(y);
  assert.equal(report.readingList.kind, 'synced');
});

test('a peer file cannot plant a non-http entry or a second entry for one url', async () => {
  assert.equal(readingList.parseRecord({ kind: 'entry', url: 'javascript:alert(1)', title: 't', read: false }), null);
  assert.equal(readingList.parseRecord({ kind: 'entry', url: 'https://ok.example/', title: 't', read: 'yes' }), null);
  const honest = await readingItemId('https://a.example/');
  const forged = await readingItemId('https://forged.example/');
  const entry = { kind: 'entry', url: 'https://a.example/', title: 't', read: false } as const;
  const kept = readingList.normalize(new Map([[honest, entry], [forged, entry]]), new Map());
  assert.equal(kept.size, 1, 'one entry per url survives normalize');
});
