// The service worker entry. Thin by design: register listeners, turn each into `scheduler.request`, and compose
// the engine for one cycle. Every listener is registered synchronously at top level, or Chrome drops the event that
// woke us. Nothing here holds state across wakes: the worker is rebuilt from IndexedDB and chrome.storage each time.
import { createEngine } from '../engine.ts';
import { registry } from '../registry.ts';
import { gzipJson } from '../store-format.ts';
import { chromeBookmarks, idbIdMap } from '../adapters/chrome-bookmarks.ts';
import { chromeHistory, chromeNativeHistory } from '../adapters/chrome-history.ts';
import { openCorpus, openCorpusReader } from '../adapters/corpus.ts';
import { fsaStore, idbHandleVault } from '../adapters/fsa-store.ts';
import { webdavStore } from '../adapters/webdav-store.ts';
import { connectHost, stageBacklog, withNativeHistory } from '../file-mode/host-link.ts';
import type { Profile, Store } from '../ports.ts';
import { chromeWake, readSettings, writeStatus } from './chrome-io.ts';
import { idbCounters, idbLocalState } from './local-idb.ts';
import { serve } from './rpc.ts';
import { createScheduler, POLL_MINUTES } from './scheduler.ts';
import type { CycleResult, Trigger } from './scheduler.ts';

const local = idbLocalState(registry, { deviceName: () => 'this device' });

const scheduler = createScheduler({
  counters: idbCounters(),
  wake: chromeWake,
  now: Date.now,
  runCycle: async (budget): Promise<CycleResult> => {
    const settings = await readSettings();
    if (settings.store === null) return { kind: 'complete' }; // not set up. Setup's first act is a 'settings' trigger.

    const store: Store = settings.store.kind === 'folder' ? fsaStore(idbHandleVault()) : webdavStore(settings.store);
    const corpus = await openCorpus();
    const history = chromeHistory({ native: chromeNativeHistory(), corpus, nowMs: Date.now });
    const link = settings.fileMode ? connectHost() : null; // the whole file-mode boundary is this line and the next
    const profile: Profile<typeof registry> = {
      bookmarks: chromeBookmarks({ device: async () => (await local.device()).device, ids: idbIdMap(), maxWritesPerApply: 90 }),
      history: link === null ? history : withNativeHistory(history, link),
    };
    if (link !== null) await stageBacklog(corpus, link);

    const engine = createEngine({
      registry, store, profile, local, codec: gzipJson, clock: { now: Date.now },
      platform: (await chrome.runtime.getPlatformInfo()).os, appVersion: chrome.runtime.getManifest().version,
    });
    const report = await engine.sync({ budget });
    await writeStatus({ cycle: { state: 'idle' }, last: report, lastError: null, fileMode: link === null ? null : await link.status() });
    return report.complete ? { kind: 'complete' } : { kind: 'partial', retryInMs: 60_000 };
  },
});

const request = (trigger: Trigger) => () => scheduler.request(trigger);

// ---- triggers ----
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') void chrome.runtime.openOptionsPage(); // CWS install lands on setup, no terminal, no hunting
  scheduler.request('install');
});
chrome.runtime.onStartup.addListener(request('startup'));
chrome.alarms.onAlarm.addListener((alarm) => scheduler.request(alarm.name === 'poll' ? 'poll' : 'resume'));

chrome.bookmarks.onCreated.addListener(request('bookmarks'));
chrome.bookmarks.onRemoved.addListener(request('bookmarks'));
chrome.bookmarks.onChanged.addListener(request('bookmarks'));
chrome.bookmarks.onMoved.addListener(request('bookmarks'));
chrome.bookmarks.onChildrenReordered.addListener(request('bookmarks'));
chrome.bookmarks.onImportEnded.addListener(request('bookmarks')); // not onImportBegan: an import fires thousands of onCreated, the debounce coalesces them
chrome.history.onVisited.addListener(request('history'));
chrome.history.onVisitRemoved.addListener(request('history'));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'settings' in changes) scheduler.request('settings');
});

// Runs at top level, so on every wake: alarms may not survive a browser restart. `get` first, so a live alarm keeps its schedule.
function ensureAlarms(): void {
  void chrome.alarms.get('poll').then((alarm) => {
    if (!alarm) void chrome.alarms.create('poll', { periodInMinutes: POLL_MINUTES });
  });
}
ensureAlarms();

// ---- pages ask, never write engine state ----
serve({
  'sync-now': async () => { scheduler.request('manual'); throw new Error('not implemented: resolve when the drain finishes'); },
  preview: async () => { throw new Error('not implemented: engine.sync({ dryRun: true }) under the cycle lock'); },
  'confirm-mass-delete': async () => { throw new Error('not implemented: persist force=[type] for one cycle, then request'); },
  'forget-visits': async () => { throw new Error('not implemented: corpus.write({ remove }) then request sync'); },
  'remove-device': async () => { throw new Error('not implemented: engine.forget() under the cycle lock'); },
});

// ---- omnibox: remote history without a cycle, straight from the corpus ----
chrome.omnibox.setDefaultSuggestion({ description: 'Search synced history for %s' });
chrome.omnibox.onInputChanged.addListener((text, suggest) => {
  // openCorpusReader().search({ text, limit: 5 }) -> suggest(hits.map(h => ({ content: h.visit.url, description: xmlEscape(title) + ' <dim>' + host + ', ' + day + '</dim>' })))
  // Titles and urls come from peer files: escape them for the omnibox's XML-ish markup.
  void text; void suggest; void openCorpusReader;
});
chrome.omnibox.onInputEntered.addListener((text) => {
  // A url (from a suggestion) opens in the current tab. Free text opens history.html?q=<text>.
  void text;
});
