// The MV3 service worker: listeners, wiring, and the page protocol. When to sync is scheduler.ts; what a sync
// does is engine.ts. Every listener is registered synchronously during the entry module's first evaluation
// (worker.ts calls startWorker at top level), so Chromium can wake the worker for any of them. Nothing here
// holds state across wakes: each cycle rebuilds the engine from IndexedDB.
//
// Which store backend sync talks to is the one thing the entry chooses: stores.ts in the release entry
// (worker.ts), which serves the folder or WebDAV server setup chose; dev-store.ts in the dev entry (worker-dev.ts).
import { createEngine, type Engine } from './engine.ts';
import { chromeBookmarks } from './chrome-bookmarks.ts';
import { chromeHistorySource } from './chrome-history.ts';
import { readingListChannel } from './chrome-reading-list.ts';
import { chromeExtensionsSource } from './chrome-extensions.ts';
import { connectCompanion, profileChannels } from './chrome-profile.ts';
import { PROTOCOL_VERSION } from './profile-mode.ts';
import { isSyncableUrl } from './history.ts';
import { historyIndex, historyLocal, indexedLocal, intents, type StoreSlot } from './local.ts';
import { parsePlatform, type Platform } from './store-format.ts';
import { ALARM_MIN_MS, POLL_MINUTES, createScheduler, withCycleLock, type Locks, type Timers, type Trigger, type Wake } from './scheduler.ts';
import { statusOf, type ProfileChannels, type StoreConnection } from './ports.ts';
import { DEVICE_NAMES, badgeFor, readShown, storedShown, viewOf, type ProfileStatus, type Shown, type StartResult, type UiMessage, type UiReply, type Wire } from './ui.ts';

/** Where sync stores its files. stores.ts's `releaseBackend` in release. */
export type StoreBackend = {
  /** Never prompts. Called at the start of every cycle, so lapsed access shows up as a paused cycle. */
  connect(slot: StoreSlot): Promise<StoreConnection>;
  /** Worker, under the cycle lock, on Start: `candidate` becomes `current`. */
  promote(): Promise<void>;
};

/** Full profile mode's optional permission, granted from Advanced. */
const NATIVE: chrome.permissions.Permissions = { permissions: ['nativeMessaging'] };

/** One cycle's companion: channels for the engine, the status to show after the cycle, and the port to close. */
type ProfileLink = { readonly channels: ProfileChannels | null; readonly status: () => ProfileStatus; readonly close: () => void };

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
  const readingList = readingListChannel(chrome.readingList);
  const extensionsSource = chromeExtensionsSource();
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

  /** Only a cycle passes `profile`; preview, Start, and Forget never touch the profile files. */
  async function engineFor(slot: StoreSlot, profile: ProfileChannels | null = null): Promise<Engine> {
    return createEngine({
      connect: () => backend.connect(slot),
      local,
      bookmarks,
      readingList,
      profile,
      history: { source: historySource, sink: index, local: historyLog },
      extensions: extensionsSource,
      clock: Date,
      platform: await platform(),
      appVersion: chrome.runtime.getManifest().version,
    });
  }

  /**
   * Full profile mode for one cycle: on only with a picked profile, the grant, and a companion that answers
   * `hello` with our protocol. Anything less is a status, never a failed cycle: the three types sit it out.
   */
  async function linkProfile(): Promise<ProfileLink> {
    const unavailable = (why: Extract<ProfileStatus, { kind: 'unavailable' }>['why']): ProfileLink => ({ channels: null, status: () => ({ kind: 'unavailable', why }), close: () => {} });
    const picked = (await local.load())?.profile ?? null;
    if (picked === null) return { channels: null, status: () => ({ kind: 'off' }), close: () => {} };
    if (!(await chrome.permissions.contains(NATIVE))) return unavailable('no-permission');
    let link: ReturnType<typeof connectCompanion>;
    try {
      link = connectCompanion();
    } catch {
      return unavailable('no-permission');
    }
    try {
      const hello = await link.hello({});
      if (hello.protocol !== PROTOCOL_VERSION) {
        link.close();
        return unavailable('protocol-mismatch');
      }
    } catch {
      link.close();
      return unavailable('no-companion');
    }
    const { channels, seen } = profileChannels(link, picked.dir);
    // Before the first read of a cycle (one that stopped early) nothing is known yet: nothing waits, rows read.
    return { channels, status: () => ({ kind: 'on', profile: picked.dir, pending: 0, webData: 'ok', ...seen() }), close: link.close };
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
      const profile = await linkProfile();
      try {
        const report = await (await engineFor('current', profile.channels)).sync({ budget, asks });
        await show({ report, failure: null, profile: profile.status() });
        return report.kind === 'cycle' && !report.complete ? { kind: 'partial' } : { kind: 'complete' };
      } catch (error) {
        const message = messageOf(error);
        await show({ failure: { at: Date.now(), message } });
        return { kind: 'failed', message };
      } finally {
        profile.close();
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
  chrome.readingList.onEntryAdded.addListener(on('reading-list'));
  chrome.readingList.onEntryUpdated.addListener(on('reading-list'));
  chrome.readingList.onEntryRemoved.addListener(on('reading-list'));
  // `management` is optional. Before the grant the namespace exists with getSelf and no events (P8 follow-up),
  // so the events are the test. A grant asks for a sync; the next worker start registers these.
  const management = chrome.management;
  if (management.onInstalled !== undefined) {
    management.onInstalled.addListener(on('extensions'));
    management.onUninstalled.addListener(on('extensions'));
    management.onEnabled.addListener(on('extensions'));
    management.onDisabled.addListener(on('extensions'));
  }
  chrome.permissions.onAdded.addListener(on('manual'));
  chrome.permissions.onRemoved.addListener(on('manual'));
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
        return withCycleLock(locks, async () => (await engineFor('candidate')).sync({ preview: true, key: message.key }));
      case 'start': {
        const name = message.name.trim().slice(0, NAME_MAX) || DEVICE_NAMES[await platform()];
        const result = await withCycleLock(locks, async (): Promise<StartResult> => {
          const conn = await backend.connect('candidate');
          if (conn.access !== 'ready') return { kind: 'not-ready', store: conn };
          const probe = await conn.store.probe();
          if (probe.kind === 'failed') return { kind: 'not-ready', store: { access: 'failed', label: conn.label, why: probe.why } };
          // The page only offers Start after a matching preview, but the folder may have changed since.
          const preview = await (await engineFor('candidate')).sync({ preview: true, key: message.key });
          if (preview.kind === 'needs-key') return { kind: 'wrong-key' };
          await backend.promote();
          // A device that was already set up (Change, or a moved folder picked again) first removes its old
          // identity's files from the store it joins, so it never syncs with itself as a peer, and drops
          // the old store's sync state. Files it never wrote there are already absent, which is fine.
          await (await engineFor('current')).forget();
          await local.reset({ name, historyOn: message.historyOn, key: message.key });
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
        return probe.kind === 'ok' ? statusOf(conn) : { access: 'failed', label: conn.label, why: probe.why };
      }
      case 'show-key':
        return (await local.load())?.key ?? null;
      case 'search-history':
        return index.search(message.query, 200);
      case 'forget-this-device':
        await withCycleLock(locks, async () => (await engineFor('current')).forget());
        await show({ report: { kind: 'needs-setup', at: Date.now() }, failure: null, profile: { kind: 'off' } });
        return null;
      case 'profile-status': {
        const permission = await chrome.permissions.contains(NATIVE);
        const on = (await local.load())?.profile ?? null;
        if (!permission) return { permission, hello: null, error: null, on };
        try {
          const link = connectCompanion();
          try {
            return { permission, hello: await link.hello({}), error: null, on };
          } finally {
            link.close();
          }
        } catch (error) {
          return { permission, hello: null, error: messageOf(error), on };
        }
      }
      case 'set-profile-mode': {
        const { dir } = message;
        await withCycleLock(locks, async () => {
          const me = await local.load();
          if (me !== null) await local.save({ ...me, profile: dir === null ? null : { dir } });
        });
        scheduler.request('manual');
        return null;
      }
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
