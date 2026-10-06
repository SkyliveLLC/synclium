// The MV3 service worker: listeners, wiring, and the page protocol. When to sync is scheduler.ts; what a sync
// does is engine.ts. Every listener is registered synchronously during the entry module's first evaluation
// (worker.ts calls startWorker at top level), so Chromium can wake the worker for any of them. Nothing here
// holds state across wakes: each cycle rebuilds the engine from IndexedDB.
//
// Which store sync talks to is the one thing the entry chooses: folder-store.ts in the release entry (worker.ts),
// dev-store.ts in the dev entry (worker-dev.ts).
import { createEngine, type Engine } from './engine.ts';
import { chromeBookmarks } from './chrome-bookmarks.ts';
import { chromeHistorySource } from './chrome-history.ts';
import { isSyncableUrl } from './history.ts';
import { historyIndex, historyLocal, indexedLocal, intents, type HandleSlot } from './local.ts';
import { gzipJson, parsePlatform, type Platform } from './store-format.ts';
import { ALARM_MIN_MS, POLL_MINUTES, createScheduler, withCycleLock, type Locks, type Timers, type Trigger, type Wake } from './scheduler.ts';
import type { StoreConnection } from './ports.ts';
import { DEVICE_NAMES, badgeFor, readShown, storedShown, viewOf, type Shown, type StartResult, type UiMessage, type UiReply, type Wire } from './ui.ts';

/** Where sync stores its files. folder-store.ts's `folderBackend` in release. */
export type StoreBackend = {
  /** Never prompts. Called at the start of every cycle, so lapsed access shows up as a paused cycle. */
  connect(slot: HandleSlot): Promise<StoreConnection>;
  /** Worker, under the cycle lock, on Start: `candidate` becomes `current`. */
  promote(): Promise<void>;
};

const POLL = 'poll';
const RESUME = 'resume';
const NAME_MAX = 64;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The omnibox description is XML: titles and urls come from peer files. */
const escapeXml = (s: string): string => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function startWorker(backend: StoreBackend): void {
  const local = indexedLocal();
  const index = historyIndex();
  const historyLog = historyLocal();
  const bookmarks = chromeBookmarks();
  const historySource = chromeHistorySource();
  const platform = async (): Promise<Platform> => parsePlatform((await chrome.runtime.getPlatformInfo()).os);

  const locks: Locks = {
    // The lock is held until the callback's promise settles, which is after `fn` settles.
    request: (name, { ifAvailable }, fn) =>
      new Promise((resolve, reject) => {
        navigator.locks.request(name, { ifAvailable }, (lock) => fn(lock !== null).then(resolve, reject)).catch(reject);
      }),
  };
  const timers: Timers = {
    set: (fn, delayMs) => ({ id: self.setTimeout(fn, delayMs) }),
    clear: (handle) => self.clearTimeout(handle.id),
  };
  const wake: Wake = {
    // One-shot, and never pushed later: an alarm already due sooner stays.
    async arm(delayMs) {
      const when = Date.now() + Math.max(ALARM_MIN_MS, delayMs);
      const armed = await chrome.alarms.get(RESUME);
      if (armed !== undefined && armed.scheduledTime <= when) return;
      await chrome.alarms.create(RESUME, { when });
    },
    async disarm() {
      await chrome.alarms.clear(RESUME);
    },
  };

  async function engineFor(slot: HandleSlot): Promise<Engine> {
    return createEngine({
      connect: () => backend.connect(slot),
      local,
      bookmarks,
      history: { source: historySource, sink: index, local: historyLog },
      codec: gzipJson,
      clock: Date,
      platform: await platform(),
      appVersion: chrome.runtime.getManifest().version,
    });
  }

  /** Pages render from storage, so they work while the worker sleeps. The badge carries no time, so it never goes stale. */
  async function show(next: Partial<Shown>): Promise<void> {
    const shown: Shown = { ...(await readShown()), ...next };
    await chrome.storage.local.set(storedShown(shown));
    const badge = badgeFor(viewOf(shown));
    await chrome.action.setBadgeText({ text: badge.text });
    await chrome.action.setTitle({ title: badge.title });
  }

  const scheduler = createScheduler({
    intents: intents(),
    wake,
    locks,
    timers,
    ping: () => void chrome.runtime.getPlatformInfo(),
    now: Date.now,
    runCycle: async (budget, asks) => {
      try {
        const report = await (await engineFor('current')).sync({ budget, asks });
        await show({ report, failure: null });
        return report.kind === 'cycle' && !report.complete ? { kind: 'partial' } : { kind: 'complete' };
      } catch (error) {
        const message = messageOf(error);
        await show({ failure: { at: Date.now(), message } });
        return { kind: 'failed', message };
      }
    },
  });
  const on = (trigger: Trigger) => () => scheduler.request(trigger);

  chrome.runtime.onInstalled.addListener(({ reason }) => {
    if (reason === 'install') void chrome.tabs.create({ url: chrome.runtime.getURL('app.html#setup') });
    scheduler.request('install');
  });
  chrome.runtime.onStartup.addListener(on('startup'));
  chrome.alarms.onAlarm.addListener((alarm) => scheduler.request(alarm.name === POLL ? 'poll' : 'resume'));

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
  void chrome.alarms.get(POLL).then((alarm) => {
    if (alarm === undefined) void chrome.alarms.create(POLL, { periodInMinutes: POLL_MINUTES });
  });

  chrome.omnibox.setDefaultSuggestion({ description: 'Search history from your other devices' });
  chrome.omnibox.onInputChanged.addListener((text, suggest) => {
    void index.search(text, 30).then((visits) => {
      const seen = new Set<string>();
      const unique = visits.filter((v) => !seen.has(v.url) && seen.add(v.url)).slice(0, 6);
      suggest(unique.map((v) => ({ content: v.url, description: `${escapeXml(v.title || v.url)} <dim>${escapeXml(v.deviceName)}</dim> <url>${escapeXml(v.url)}</url>` })));
    });
  });
  // A picked suggestion is a url; plain text the user typed opens the History tab searching for it.
  chrome.omnibox.onInputEntered.addListener((text, disposition) => {
    const url = isSyncableUrl(text) ? text : chrome.runtime.getURL(`app.html?q=${encodeURIComponent(text)}#history`);
    if (disposition === 'currentTab') void chrome.tabs.update({ url });
    else void chrome.tabs.create({ url, active: disposition === 'newForegroundTab' });
  });

  /** Exhaustive over UiMessage; the reply type follows the message. */
  function handle<M extends UiMessage>(message: M): Promise<UiReply<M>>;
  async function handle(message: UiMessage): Promise<UiReply<UiMessage>> {
    switch (message.kind) {
      case 'sync-now':
        scheduler.request('manual');
        return null;
      case 'preview':
        return withCycleLock(locks, async () => (await engineFor('candidate')).sync({ preview: true }));
      case 'start': {
        const name = message.name.trim().slice(0, NAME_MAX) || DEVICE_NAMES[await platform()];
        const result = await withCycleLock(locks, async (): Promise<StartResult> => {
          const conn = await backend.connect('candidate');
          if (conn.access !== 'ready') return { kind: 'not-ready', store: conn };
          const probe = await conn.store.probe();
          if (probe.kind === 'failed') return { kind: 'not-ready', store: { access: 'failed', label: conn.label, why: probe.why } };
          await backend.promote();
          // A device that was already set up (Change folder, or a moved folder picked again) first removes its
          // old identity's files from the folder it joins, so it never syncs with itself as a peer, and drops
          // the old folder's sync state. Files it never wrote there are already absent, which is fine.
          await (await engineFor('current')).forget();
          await local.reset({ name, historyOn: message.historyOn });
          return { kind: 'started' };
        });
        if (result.kind === 'started') scheduler.request('setup');
        return result;
      }
      case 'set-history':
        await withCycleLock(locks, async () => {
          const me = await local.load();
          if (me !== null) await local.save({ ...me, historyOn: message.on });
        });
        scheduler.request('manual');
        return null;
      case 'apply-deletions':
        scheduler.request('apply-deletions');
        return null;
      case 'check-store': {
        const conn = await backend.connect('current');
        if (conn.access !== 'ready') return conn;
        const probe = await conn.store.probe();
        return probe.kind === 'ok' ? { access: 'ready', label: conn.label } : { access: 'failed', label: conn.label, why: probe.why };
      }
      case 'search-history':
        return index.search(message.query, 200);
      case 'forget-this-device':
        await withCycleLock(locks, async () => (await engineFor('current')).forget());
        await show({ report: { kind: 'needs-setup', at: Date.now() }, failure: null });
        return null;
      default: {
        const unreachable: never = message;
        return unreachable;
      }
    }
  }

  // Only this extension's own pages talk to the worker, and they share ui.ts's types, so the message is trusted.
  chrome.runtime.onMessage.addListener((message: UiMessage, sender, respond: (wire: Wire<UiReply<UiMessage>>) => void) => {
    if (sender.id !== chrome.runtime.id || sender.url?.startsWith(chrome.runtime.getURL('')) !== true) return false;
    handle(message).then(
      (value) => respond({ ok: true, value }),
      (error: unknown) => respond({ ok: false, message: messageOf(error) }),
    );
    return true;
  });
}
