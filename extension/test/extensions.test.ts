// Extensions as a snapshot: each device publishes its own list when the user granted `management`; peers
// show what they lack. Nothing is merged or applied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, syncedPair, type Device } from './support/harness.ts';
import { offers, type ExtensionInfo } from '../src/extensions.ts';
import type { SyncReport } from '../src/engine.ts';

const cycleReport = async (d: Device): Promise<Extract<SyncReport, { kind: 'cycle' }>> => {
  const report = await d.cycle();
  if (report.kind !== 'cycle') throw new Error(`expected a cycle, got ${report.kind}`);
  return report;
};
const ext = (letter: string, name: string, source: ExtensionInfo['source'] = 'store'): ExtensionInfo => ({ id: letter.repeat(32), name, enabled: true, source });

test('a granted device publishes its list; a peer sees it; revoking takes it back out of the folder', async () => {
  const world = new World('icloud');
  const { x, y } = await syncedPair(world);
  x.extensionList = [ext('a', 'uBlock Origin'), ext('b', 'Dark Reader')];
  await x.cycle();
  const seen = await cycleReport(y);
  assert.deepEqual(seen.extensions, [{ device: x.device, name: 'X', extensions: x.extensionList }]);
  assert.deepEqual((await cycleReport(x)).extensions, [], 'Y never granted, so it publishes nothing');

  x.extensionList = null;
  await x.cycle();
  assert.deepEqual((await cycleReport(y)).extensions, [], 'X\'s list left with its file');
});

test('offers: what peers have and this device lacks, once per extension, addable if any device got it from the store', () => {
  const peers = [
    { name: 'Mac', extensions: [ext('a', 'uBlock Origin'), ext('c', 'My tool', 'unpacked')] },
    { name: 'Linux PC', extensions: [ext('b', 'Dark Reader', 'other'), ext('c', 'My tool', 'unpacked')] },
    { name: 'Windows PC', extensions: [ext('b', 'Dark Reader')] },
  ];
  assert.deepEqual(offers(peers, new Set(['a'.repeat(32)])), [
    { id: 'b'.repeat(32), name: 'Dark Reader', source: 'store', on: ['Linux PC', 'Windows PC'] },
    { id: 'c'.repeat(32), name: 'My tool', source: 'unpacked', on: ['Mac', 'Linux PC'] },
  ]);
});
