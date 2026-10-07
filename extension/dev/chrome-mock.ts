// A fake `chrome` for previewing the extension's pages in a plain browser tab, served by scripts/dev.mjs.
// It answers the page -> worker protocol (ui.ts) from canned reports instead of running the engine, so every
// state the UI can show is one URL away: /app.html?scenario=review#status. Type imports only: dev.mjs strips
// the types and serves this file as is, and `npm run typecheck` keeps the scenarios in step with the real types.
import type { SyncReport } from '../src/engine.ts';
import type { RemoteVisit } from '../src/local.ts';
import type { DeviceId } from '../src/model.ts';
import type { SyncKey } from '../src/sync-key.ts';
import type { Shown, UiMessage, UiReply, Wire } from '../src/ui.ts';

const VERSION = 'dev';
const SHOWN_KEY = 'shown';
const now = Date.now();
const MIN = 60_000;
const DAY = 86_400_000;

/** Fake DeviceIds in the UUID shape model.ts expects. */
const fakeId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as DeviceId;

type Cycle = Extract<SyncReport, { kind: 'cycle' }>;

const healthy: Cycle = {
  kind: 'cycle',
  device: fakeId(1),
  name: 'MacBook Pro',
  at: now - 2 * MIN,
  complete: true,
  store: { access: 'ready', label: 'Helium Sync' },
  bookmarks: { kind: 'synced', stamped: 2, applied: { added: 3, updated: 1, removed: 0, sample: [] } },
  readingList: { kind: 'synced', stamped: 0, applied: { added: 1, updated: 0, removed: 0, sample: [] } },
  settings: { kind: 'off' },
  searchEngines: { kind: 'off' },
  addresses: { kind: 'off' },
  history: { kind: 'synced', collected: 41, publishedDays: 62, unpublishedDays: 0, pulledDays: 4, deriveDaysLeft: 0 },
  peers: [
    { device: fakeId(2), name: 'Studio iMac', lastSeen: now - 5 * MIN, idle: false },
    { device: fakeId(3), name: 'Work laptop', lastSeen: now - 180 * MIN, idle: false },
    { device: fakeId(4), name: 'Old ThinkPad', lastSeen: now - 40 * DAY, idle: true },
  ],
  extensions: [],
  warnings: [],
};

const shown = (report: SyncReport | null, failure: Shown['failure'] = null): Shown => ({ report, failure, profile: { kind: 'off' } });

/** Every state worth previewing. The key is the `?scenario=` value; the first is the default. */
const SCENARIOS = {
  healthy: shown(healthy),
  alone: shown({ ...healthy, peers: [], bookmarks: { kind: 'synced', stamped: 0, applied: { added: 0, updated: 0, removed: 0, sample: [] } } }),
  'catching-up': shown({
    ...healthy,
    complete: false,
    history: { kind: 'synced', collected: 0, publishedDays: 34, unpublishedDays: 0, pulledDays: 6, deriveDaysLeft: 28 },
    warnings: [{ kind: 'not-yet', peer: fakeId(2), file: 'history/2026-10-05.json.gz' }],
  }),
  'needs-permission': shown({ ...healthy, store: { access: 'failed', label: 'Helium Sync', why: { kind: 'needs-permission' } } }),
  'folder-missing': shown({ ...healthy, store: { access: 'failed', label: 'Helium Sync', why: { kind: 'missing' } } }),
  'server-offline': shown({ ...healthy, store: { access: 'failed', label: 'Helium Sync on cloud.example.com', why: { kind: 'unreachable', detail: 'server error 503' } } }),
  review: shown({
    ...healthy,
    bookmarks: { kind: 'blocked', why: { kind: 'mass-delete', removed: { added: 0, updated: 0, removed: 212, sample: ['Recipes', 'Hacker News', 'MDN Web Docs'] }, of: 340 } },
  }),
  outdated: shown({ ...healthy, bookmarks: { kind: 'blocked', why: { kind: 'newer-type-version', peer: fakeId(2), version: 2 } } }),
  clash: shown({ kind: 'identity-clash', at: now, device: fakeId(1) }),
  error: shown(healthy, { at: now, message: 'NotReadableError: the folder could not be read' }),
  setup: shown(null),
} satisfies Record<string, Shown>;
type Scenario = keyof typeof SCENARIOS;

const isScenario = (s: string | null): s is Scenario => s !== null && s in SCENARIOS;
const requested = new URLSearchParams(location.search).get('scenario');
const scenario: Scenario = isScenario(requested) ? requested : 'healthy';
let state: Shown = SCENARIOS[scenario];

const VISITS: readonly RemoteVisit[] = [
  { device: fakeId(2), deviceName: 'Studio iMac', url: 'https://developer.chrome.com/docs/extensions', title: 'Chrome Extensions docs', t: now - 20 * MIN },
  { device: fakeId(2), deviceName: 'Studio iMac', url: 'https://news.ycombinator.com/', title: 'Hacker News', t: now - 90 * MIN },
  { device: fakeId(3), deviceName: 'Work laptop', url: 'https://github.com/SkyliveLLC/synclium', title: 'SkyliveLLC/synclium', t: now - 5 * 60 * MIN },
  { device: fakeId(3), deviceName: 'Work laptop', url: 'https://www.typescriptlang.org/docs/', title: 'TypeScript docs', t: now - 26 * 60 * MIN },
];

// ---------- chrome.storage.local: holds only `shown`, as the worker's writes would ----------

type StorageChange = { readonly newValue?: unknown; readonly oldValue?: unknown };
const listeners: ((changes: { readonly [key: string]: StorageChange }) => void)[] = [];
const stored = () => ({ ...state, app: VERSION });

/** What the worker does after a cycle: write `shown`, which every open page re-renders from. */
function publish(next: Shown): void {
  const oldValue = stored();
  state = next;
  for (const listener of listeners) listener({ [SHOWN_KEY]: { oldValue, newValue: stored() } });
}

const cycleOf = (s: Shown): Cycle | null => (s.report?.kind === 'cycle' ? s.report : null);

// ---------- The worker side of ui.ts's protocol ----------

/** Exhaustive over UiMessage, like background.ts `handle`, so a new message fails to compile until it has a fake. */
function handle<M extends UiMessage>(message: M): UiReply<M>;
function handle(message: UiMessage): UiReply<UiMessage> {
  const cycle = cycleOf(state);
  switch (message.kind) {
    case 'sync-now':
      // Long enough to see the device map pulse.
      setTimeout(() => publish({ ...state, report: cycle === null ? state.report : { ...cycle, at: Date.now() }, failure: null }), 1200);
      return null;
    case 'preview':
      return { kind: 'joining', label: 'Helium Sync', peers: ['Studio iMac', 'Work laptop'], bookmarks: { matched: 498, toAdd: 14, toPublish: 37 }, historyDays: 62 };
    case 'start':
      setTimeout(() => publish(shown({ ...healthy, name: message.name || healthy.name, at: Date.now() })), 800);
      return { kind: 'started' };
    case 'set-history':
      if (cycle !== null) publish({ ...state, report: { ...cycle, history: message.on ? healthy.history : { kind: 'off' } } });
      return null;
    case 'apply-deletions':
      setTimeout(() => publish(shown({ ...healthy, at: Date.now() })), 800);
      return null;
    case 'check-store':
      return cycle?.store ?? { access: 'not-set-up' };
    case 'search-history': {
      const q = message.query.trim().toLowerCase();
      return VISITS.filter((v) => q === '' || v.title.toLowerCase().includes(q) || v.url.includes(q));
    }
    case 'show-key':
      return cycle === null ? null : ('0123456789ABCDEFGHJKMNPQRSTVWXYZ0123456789ABCDEFGHJK' as SyncKey);
    case 'profile-status':
      return { permission: false, hello: null, error: null, on: null };
    case 'set-profile-mode':
      return null;
    case 'forget-this-device':
      publish(shown({ kind: 'needs-setup', at: Date.now() }));
      return null;
    default: {
      const unreachable: never = message;
      return unreachable;
    }
  }
}

/** Extension URLs become preview URLs that keep the current scenario. */
const previewUrl = (path: string) => {
  const url = new URL(path.replace(/^\//, ''), `${location.origin}/`);
  url.searchParams.set('scenario', scenario);
  return url.href;
};

const fakeChrome = {
  runtime: {
    id: 'dev-preview',
    getManifest: () => ({ version: VERSION }),
    getPlatformInfo: async () => ({ os: 'mac' }),
    getURL: previewUrl,
    sendMessage: async (message: UiMessage): Promise<Wire<UiReply<UiMessage>>> => {
      try {
        return { ok: true, value: handle(message) };
      } catch (error) {
        return { ok: false, message: String(error) };
      }
    },
  },
  storage: {
    local: {
      get: async (key: string) => (key === SHOWN_KEY ? { [SHOWN_KEY]: stored() } : {}),
      set: async () => {},
      onChanged: { addListener: (listener: (typeof listeners)[number]) => void listeners.push(listener) },
    },
  },
  // Nothing optional is granted in the preview: Extensions and full profile mode show their opt-in step.
  permissions: {
    contains: async () => false,
    request: async () => false,
    remove: async () => true,
  },
  tabs: {
    create: ({ url }: { readonly url: string }) => void window.open(url, '_blank'),
    update: ({ url }: { readonly url: string }) => void location.assign(url),
  },
};

Object.assign(globalThis, { chrome: fakeChrome });
console.info(`[dev] fake chrome, scenario "${scenario}". Others: ${Object.keys(SCENARIOS).join(', ')}`);

// ---------- Preview toolbar: switch scenario or page without editing the URL ----------

function toolbar(): HTMLElement {
  const bar = document.createElement('div');
  bar.style.cssText =
    'position:fixed;right:12px;bottom:12px;z-index:9999;display:flex;gap:8px;align-items:center;padding:6px 8px;' +
    'font:12px system-ui;background:#2a2a2e;color:#eee;border-radius:8px;box-shadow:0 2px 10px rgb(0 0 0 / .3)';
  const select = document.createElement('select');
  select.setAttribute('aria-label', 'Preview scenario');
  for (const name of Object.keys(SCENARIOS)) select.add(new Option(name, name, false, name === scenario));
  select.onchange = () => {
    const url = new URL(location.href);
    url.searchParams.set('scenario', select.value);
    location.assign(url);
  };
  const page = document.createElement('a');
  const onPopup = location.pathname.endsWith('popup.html');
  page.textContent = onPopup ? 'App' : 'Popup';
  page.href = previewUrl(onPopup ? 'app.html#status' : 'popup.html');
  page.style.color = '#9db4ff';
  bar.append('dev', select, page);
  return bar;
}
// Module scripts run after parsing, so the body exists.
document.body.append(toolbar());
