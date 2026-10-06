// The MV3 service worker: listeners, wiring, and the page protocol. When to sync is scheduler.ts; what a sync
// does is engine.ts. Every listener is registered synchronously at top level, so Chromium can wake the worker
// for any of them. Nothing here holds state across wakes: each cycle rebuilds the engine from IndexedDB.
// (The companion's native port, when opted in, is a connection, not state; losing it is harmless.)
import { createEngine, type Engine, type SyncReport } from './engine.ts';
import { connectFolder, promoteCandidate, type HandleSlot } from './folder-store.ts';
import { chromeBookmarks } from './chrome-bookmarks.ts';
import { chromeHistorySource } from './chrome-history.ts';
import { historyIndex, historyLocal, indexedLocal, intents } from './local.ts';
import { gzipJson, parsePlatform } from './store-format.ts';
import { createScheduler, POLL_MINUTES, withCycleLock, type CycleResult, type Trigger, type Wake } from './scheduler.ts';
import { badgeFor, viewOf, type UiMessage, type UiReply } from './ui.ts';
import { connectCompanion, withCompanion } from './companion/link.ts';

const local = indexedLocal();
const index = historyIndex();

async function engineFor(slot: HandleSlot): Promise<Engine> {
  const companion = await connectCompanion(); // null unless opted in: the whole file-mode boundary is this line
  return createEngine({
    connect: () => connectFolder(slot),
    local,
    bookmarks: chromeBookmarks(),
    history: {
      source: chromeHistorySource(),
      sink: companion === null ? index : withCompanion(index, companion),
      local: historyLocal(),
    },
    codec: gzipJson,
    clock: Date,
    platform: parsePlatform((await chrome.runtime.getPlatformInfo()).os),
    appVersion: chrome.runtime.getManifest().version,
  });
}

/** The popup renders from storage, so it works while the worker sleeps. */
async function publishReport(report: SyncReport): Promise<void> {
  await chrome.storage.local.set({ report });
  const badge = badgeFor(viewOf(report));
  await chrome.action.setBadgeText({ text: badge.text });
  await chrome.action.setTitle({ title: badge.title });
}

const wake: Wake = {
  arm: async (_delayMs) => {
    throw new Error('not implemented: chrome.alarms.create("resume", { delayInMinutes: max(0.5, ms / 60000) }) unless one is due sooner');
  },
  disarm: async () => {
    await chrome.alarms.clear('resume');
  },
};

const scheduler = createScheduler({
  intents: intents(),
  wake,
  now: Date.now,
  runCycle: async (budget, asks): Promise<CycleResult> => {
    try {
      const report = await (await engineFor('current')).sync({ budget, asks });
      await publishReport(report);
      return report.kind === 'cycle' && !report.complete ? { kind: 'partial' } : { kind: 'complete' };
    } catch (error) {
      return { kind: 'failed', message: String(error) };
    }
  },
});

const on = (trigger: Trigger) => () => scheduler.request(trigger);

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') void chrome.tabs.create({ url: chrome.runtime.getURL('app.html#setup') });
  scheduler.request('install');
});
chrome.runtime.onStartup.addListener(on('startup'));
chrome.alarms.onAlarm.addListener((alarm) => scheduler.request(alarm.name === 'poll' ? 'poll' : 'resume'));

chrome.bookmarks.onCreated.addListener(on('bookmarks'));
chrome.bookmarks.onChanged.addListener(on('bookmarks'));
chrome.bookmarks.onMoved.addListener(on('bookmarks'));
chrome.bookmarks.onRemoved.addListener(on('bookmarks'));
chrome.bookmarks.onChildrenReordered.addListener(on('bookmarks'));
chrome.bookmarks.onImportEnded.addListener(on('bookmarks'));
// New visits need no trigger: the poll scans them. A removal cannot say which visits went (a range delete
// lists no urls), so it asks for a re-derive of every own day, as a durable intent the engine acknowledges.
chrome.history.onVisitRemoved.addListener(on('history-removed'));

// Every wake: alarms may not survive a browser restart. `get` first, so a live alarm keeps its schedule.
void chrome.alarms.get('poll').then((alarm) => {
  if (alarm === undefined) void chrome.alarms.create('poll', { periodInMinutes: POLL_MINUTES });
});

chrome.omnibox.setDefaultSuggestion({ description: 'Search history from your other devices' });
chrome.omnibox.onInputChanged.addListener((text, suggest) => {
  // Titles and urls come from peer files: XML-escape them for the omnibox description markup.
  void index.search(text, 6).then((visits) => suggest(visits.map((v) => ({ content: v.url, description: escapeXml(`${v.title} (${v.deviceName})`) }))));
});
chrome.omnibox.onInputEntered.addListener((url) => void chrome.tabs.update({ url }));

function escapeXml(_s: string): string {
  throw new Error('not implemented');
}

/** Exhaustive over UiMessage; the reply type follows the message. */
function handle<M extends UiMessage>(message: M): Promise<UiReply<M>>;
async function handle(message: UiMessage): Promise<UiReply<UiMessage>> {
  switch (message.kind) {
    case 'sync-now':
      scheduler.request('manual');
      return null;
    case 'preview':
      return withCycleLock(async () => (await engineFor('candidate')).sync({ preview: true }));
    case 'start':
      await withCycleLock(async () => {
        await promoteCandidate();
        await local.reset({ name: message.name, historyOn: message.historyOn });
      });
      scheduler.request('setup');
      return null;
    case 'set-history':
      await withCycleLock(async () => {
        const me = await local.load();
        if (me !== null) await local.save({ ...me, historyOn: message.on });
      });
      scheduler.request('manual');
      return null;
    case 'apply-deletions':
      scheduler.request('apply-deletions');
      return null;
    case 'check-store': {
      const conn = await connectFolder('current');
      if (conn.access !== 'ready') return conn;
      const probe = await conn.store.probe();
      return probe.kind === 'ok' ? { access: 'ready', label: conn.label } : { access: 'failed', label: conn.label, why: probe.why };
    }
    case 'search-history':
      return index.search(message.query, 200);
    case 'forget-this-device':
      await withCycleLock(async () => (await engineFor('current')).forget());
      return null;
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
