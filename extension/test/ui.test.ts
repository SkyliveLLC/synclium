// The popup's view model: which state the user sees, which button it offers, and whether the badge asks for attention.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { badgeFor, previewSentence, primaryAction, viewOf, type Shown } from '../src/ui.ts';
import type { SyncReport } from '../src/engine.ts';
import { deviceId } from './support/memory-local.ts';

type Cycle = Extract<SyncReport, { kind: 'cycle' }>;

const healthy: Cycle = {
  kind: 'cycle',
  device: deviceId(1),
  name: 'Mac',
  at: 1_000_000,
  complete: true,
  store: { access: 'ready', label: 'Helium Sync' },
  bookmarks: { kind: 'synced', stamped: 0, applied: { added: 0, updated: 0, removed: 0, sample: [] } },
  history: { kind: 'synced', collected: 0, publishedDays: 3, unpublishedDays: 0, pulledDays: 0, deriveDaysLeft: 0 },
  peers: [
    { device: deviceId(2), name: 'Laptop', lastSeen: 999_000, idle: false },
    { device: deviceId(3), name: 'Old PC', lastSeen: 1, idle: true },
  ],
  warnings: [],
};
const shown = (report: SyncReport | null, failure: Shown['failure'] = null): Shown => ({ report, failure });

test('a healthy cycle is ok with a blank badge, counting only live peers', () => {
  const view = viewOf(shown(healthy));
  assert.deepEqual(view, { kind: 'ok', lastSync: 1_000_000, devices: 1, catchingUp: false, problems: 0 });
  assert.equal(badgeFor(view).text, '');
  assert.equal(primaryAction(view), null);
});

test('work left for the next wake shows as catching up, not as a problem', () => {
  for (const report of [
    { ...healthy, complete: false },
    { ...healthy, history: { kind: 'synced', collected: 0, publishedDays: 3, unpublishedDays: 0, pulledDays: 0, deriveDaysLeft: 40 } },
    { ...healthy, bookmarks: { kind: 'pending', why: 'interrupted', pending: { added: 1, updated: 0, removed: 0, sample: ['x'] } } },
  ] satisfies Cycle[]) {
    const view = viewOf(shown(report));
    assert.equal(view.kind === 'ok' && view.catchingUp, true, JSON.stringify(report));
    assert.equal(badgeFor(view).text, '');
  }
});

test('a lapsed folder grant pauses with the allow button and a badge', () => {
  const view = viewOf(shown({ ...healthy, store: { access: 'failed', label: 'Helium Sync', why: { kind: 'needs-permission' } } }));
  assert.deepEqual(view, { kind: 'paused', label: 'Helium Sync', why: { kind: 'needs-permission' } });
  assert.deepEqual(primaryAction(view), { label: 'Allow access', opens: 'app.html#allow' });
  assert.equal(badgeFor(view).text, '!');
});

test('a blocked mass delete asks for review, and wins over a healthy store', () => {
  const removed = { added: 0, updated: 0, removed: 40, sample: ['a', 'b'] };
  const view = viewOf(shown({ ...healthy, bookmarks: { kind: 'blocked', why: { kind: 'mass-delete', removed, of: 60 } } }));
  assert.deepEqual(view, { kind: 'review', removed: 40, of: 60, sample: ['a', 'b'] });
  assert.deepEqual(primaryAction(view), { label: 'Review', opens: 'app.html#review' });
  assert.equal(badgeFor(view).text, '!');
});

test('a cycle that threw after the last report shows the error; an older failure is superseded by the report', () => {
  assert.deepEqual(viewOf(shown(healthy, { at: healthy.at + 1, message: 'boom' })), { kind: 'error', message: 'boom' });
  assert.equal(viewOf(shown(healthy, { at: healthy.at - 1, message: 'boom' })).kind, 'ok');
  assert.equal(viewOf(shown(null)).kind, 'setup');
});

test('the join preview says what Start will do before anything is written', () => {
  assert.equal(
    previewSentence({ kind: 'joining', label: 'Helium Sync', peers: ['conan-mbp'], bookmarks: { matched: 498, toAdd: 14, toPublish: 37 }, historyDays: 90 }),
    'Joining conan-mbp. 498 bookmarks already match, 14 will be added here, 37 will be shared.',
  );
});
