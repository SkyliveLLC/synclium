// The MV3 service worker: when to sync. The engine decides what. Every listener is registered
// synchronously at top level, so Chromium can wake the worker for any of them after termination. The
// worker holds nothing in memory that matters: alarms, IndexedDB, and chrome.storage carry all state.
//
// Triggers
//   alarm 'poll'   every 5 min. Pulls peers' changes, scans new history, heartbeats. Survives restarts.
//   alarm 'soon'   one-shot, re-armed by each bookmark event, so a burst of edits is one cycle 30 s after
//                  the last (30 s is Chromium's minimum alarm delay for store-installed extensions).
//   onStartup      one cycle at browser start, which is also when folder access may have lapsed.
//   UI messages    sync-now, apply-deletions, search-history, forget-this-device.
// Cycles serialize on the Web Lock inside local.lock; a trigger during a cycle waits, then runs a cheap no-op.
import { createEngine, type SyncReport } from './engine.ts';
import { connectFolder } from './folder-store.ts';
import { chromeBookmarks } from './chrome-bookmarks.ts';
import { chromeHistorySource } from './history.ts';
import { indexedHistoryDb, indexedLocal } from './local.ts';
import { gzipJson, parsePlatform } from './store-format.ts';
import { badgeFor, viewOf, type UiMessage, type UiReply } from './ui.ts';
import { mirrorToCompanion } from './companion.ts';

const historyDb = indexedHistoryDb();

const engine = createEngine({
  connect: connectFolder,
  bookmarks: chromeBookmarks(),
  history: chromeHistorySource(),
  historyDb,
  local: indexedLocal(),
  codec: gzipJson,
  clock: Date,
  platform: () => chrome.runtime.getPlatformInfo().then((info) => parsePlatform(info.os)),
  appVersion: chrome.runtime.getManifest().version,
});

/** Run one cycle and publish its report to the UI. The only caller of engine.sync. */
async function cycle(opts?: { readonly force?: boolean }): Promise<SyncReport> {
  const report = await engine.sync(opts);
  // The companion is a no-op ({ kind: 'off' }) unless the user opted in. Its only input is the peer-visit index.
  await chrome.storage.local.set({ report, companion: await mirrorToCompanion(historyDb) });
  const badge = badgeFor(viewOf(report));
  await chrome.action.setBadgeText({ text: badge.text });
  await chrome.action.setTitle({ title: badge.title });
  return report;
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  void chrome.alarms.create('poll', { periodInMinutes: 5 });
  if (reason === 'install') void chrome.tabs.create({ url: chrome.runtime.getURL('app.html#setup') });
});
chrome.runtime.onStartup.addListener(() => void cycle());

chrome.alarms.onAlarm.addListener(() => void cycle());

const soon = () => void chrome.alarms.create('soon', { delayInMinutes: 0.5 });
chrome.bookmarks.onCreated.addListener(soon);
chrome.bookmarks.onChanged.addListener(soon);
chrome.bookmarks.onMoved.addListener(soon);
chrome.bookmarks.onRemoved.addListener(soon);
chrome.bookmarks.onChildrenReordered.addListener(soon);

// Removal events cannot say which visits went (a partial range delete reports no urls), so any removal
// re-derives all own days on the next cycle. Users delete history rarely; a re-derive is ~17k getVisits.
chrome.history.onVisitRemoved.addListener(() => {
  void engine.historyRemoved().then(soon);
});

chrome.omnibox.onInputChanged.addListener((text, suggest) => {
  void historyDb.search(text, 6).then((visits) =>
    suggest(visits.map((v) => ({ content: v.url, description: `${v.title} (${v.deviceName})` }))),
  );
});
chrome.omnibox.onInputEntered.addListener((url) => void chrome.tabs.update({ url }));

/** Exhaustive over UiMessage; the reply type follows the message. */
function handle<M extends UiMessage>(message: M): Promise<UiReply<M>>;
function handle(message: UiMessage): Promise<UiReply<UiMessage>> {
  switch (message.kind) {
    case 'sync-now':
      return cycle();
    case 'apply-deletions':
      return cycle({ force: true });
    case 'search-history':
      return historyDb.search(message.query, 200);
    case 'forget-this-device':
      return engine.forget().then(() => null);
    default: {
      const unreachable: never = message;
      return unreachable;
    }
  }
}

chrome.runtime.onMessage.addListener((message: UiMessage, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  void handle(message).then(respond);
  return true;
});
