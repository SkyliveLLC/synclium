// app.html, the options page. Routes by hash, so the popup and the worker can deep-link:
//   #setup     folder or WebDAV server, sync key, device name, history choice, join preview, Start
//   #allow     re-grant access after it lapsed (a folder after a restart, a revoked server permission)
//   #status    the dashboard: status, a map of devices around the store, bookmarks/history/store facts, problems
//   #review    a blocked mass delete and [Apply these deletions]
//   #history   search over peers' visits, grouped by device and day
//   #extensions  share this device's extensions (optional `management` permission), offers from the others
//   #advanced  settings: history toggle, sync key, change folder or server, full profile mode (optional
//              `nativeMessaging`), forget this device
// The folder picker and the permission prompts need the click's gesture, so chooseFolder, chooseWebdav,
// allowStore, and chrome.permissions.request are called synchronously in their handlers.
// Peer data (titles, urls, device names) only ever reaches the DOM as text or as an http(s) href.
import type { JoinPreview } from './engine.ts';
import {
  DEVICE_NAMES,
  SHOWN_KEY,
  ago,
  ask,
  bookmarksFact,
  folderFact,
  groupVisits,
  historyFact,
  keyNote,
  nounFor,
  previewSentence,
  primaryAction,
  profileSentence,
  readShown,
  shownFrom,
  statusSentence,
  toneOf,
  viewOf,
  warningSentence,
  type Fact,
  type Shown,
} from './ui.ts';
import { parsePlatform } from './store-format.ts';
import { formatSyncKey, mintSyncKey, parseSyncKey, type SyncKey } from './sync-key.ts';
import { offers, storePage } from './extensions.ts';
import { chooseFolder } from './folder-store.ts';
import { chooseWebdav, parseDavUrl } from './webdav-store.ts';
import { allowStore, type Chosen } from './stores.ts';
import { slots, type StoreChoice } from './local.ts';
import type { StoreFailure } from './ports.ts';
import { PROTOCOL_VERSION } from './profile-mode.ts';

const SECTIONS = ['setup', 'allow', 'status', 'review', 'history', 'extensions', 'advanced'] as const;
type Section = (typeof SECTIONS)[number];
const isSection = (s: string): s is Section => SECTIONS.some((name) => name === s);

function byId<E extends HTMLElement>(id: string, type: { new (): E }): E {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`app.html lacks #${id}`);
  return found;
}

/** A detached element with text content only. */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className !== '') node.className = className;
  return node;
}

function rows(list: HTMLUListElement, items: readonly string[], empty: string): void {
  list.replaceChildren(...(items.length === 0 ? [el('li', empty, 'empty')] : items.map((text) => el('li', text))));
}

const failureText = (label: string, why: StoreFailure): string => previewSentence({ kind: 'not-ready', store: { access: 'failed', label, why } });
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

let shown: Shown = await readShown();
const onShown: (() => void)[] = [];

// ---------- Setup ----------

const setup = {
  choose: byId('choose', HTMLButtonElement),
  chooseNote: byId('choose-note', HTMLParagraphElement),
  storeLabel: byId('store-label', HTMLParagraphElement),
  keyStep: byId('key-step', HTMLLIElement),
  keyNew: byId('key-new', HTMLDivElement),
  keyShown: byId('key-shown', HTMLElement),
  keyCopy: byId('key-copy', HTMLButtonElement),
  keyEnter: byId('key-enter', HTMLDivElement),
  keyInput: byId('key-input', HTMLInputElement),
  keyNote: byId('key-note', HTMLParagraphElement),
  name: byId('name', HTMLInputElement),
  historyOn: byId('history-on', HTMLInputElement),
  preview: byId('preview', HTMLParagraphElement),
  start: byId('start', HTMLButtonElement),
  result: byId('setup-result', HTMLParagraphElement),
};
let started: JoinPreview | null = null;
/** The key a first device keeps. Minted once per visit; a key pasted into the field takes its place. */
const freshKey = mintSyncKey();
/** Only the newest preview renders: typing a key fires one per pause. */
let previews = 0;

const copy = (key: SyncKey) => void navigator.clipboard.writeText(formatSyncKey(key));

async function enterSetup(): Promise<void> {
  if (setup.name.value === '') setup.name.value = DEVICE_NAMES[parsePlatform((await chrome.runtime.getPlatformInfo()).os)];
  const typed = setup.keyInput.value.trim();
  const pasted = typed === '' ? null : parseSyncKey(typed);
  const key = pasted ?? freshKey;
  const asked = ++previews;
  const preview = await ask({ kind: 'preview', key });
  if (asked !== previews) return;
  const ready = preview.kind !== 'not-ready';
  const startable = preview.kind === 'first-device' || preview.kind === 'joining';
  setup.chooseNote.hidden = ready;
  setup.storeLabel.hidden = !ready;
  if (ready) setup.storeLabel.textContent = `Store: ${preview.label}`;
  setup.keyStep.hidden = !ready;
  setup.keyNew.hidden = preview.kind !== 'first-device';
  setup.keyEnter.hidden = !ready || preview.kind === 'first-device';
  setup.keyShown.textContent = formatSyncKey(key);
  setup.keyCopy.onclick = () => copy(key);
  setup.keyNote.textContent = keyNote(preview, typed === '' ? 'nothing' : pasted === null ? 'not-a-key' : 'key');
  setup.preview.hidden = !startable;
  setup.preview.textContent = previewSentence(preview);
  setup.start.disabled = !startable;
  setup.start.onclick = async () => {
    setup.start.disabled = true;
    const result = await ask({ kind: 'start', name: setup.name.value, historyOn: setup.historyOn.checked, key });
    if (result.kind === 'not-ready') {
      setup.preview.textContent = previewSentence({ kind: 'not-ready', store: result.store });
      return;
    }
    if (result.kind === 'wrong-key') {
      await enterSetup(); // the folder gained devices under another key since the preview
      return;
    }
    started = preview;
    renderSetupResult();
  };
}

function setupNote(text: string): void {
  setup.preview.textContent = text;
  setup.preview.hidden = false;
  setup.start.disabled = true;
}

let keyTimer: number | undefined;
setup.keyInput.oninput = () => {
  window.clearTimeout(keyTimer);
  keyTimer = window.setTimeout(() => void enterSetup(), 250);
};

/**
 * After the picker or the Connect click. A passed probe made the choice the candidate, so the preview refreshes;
 * otherwise the note says why. `cancelled` is what to say when the user backed out, if anything.
 */
async function useChoice(choosing: Promise<Chosen>, what: string, cancelled = ''): Promise<void> {
  // One choice at a time: a second click would race the first one's probe and candidate write.
  setup.choose.disabled = true;
  dav.connect.disabled = true;
  try {
    const chosen = await choosing;
    if (chosen.kind === 'cancelled') {
      if (cancelled !== '') setupNote(cancelled);
    } else if (chosen.probe.kind === 'ok') {
      await enterSetup();
    } else {
      setupNote(failureText(chosen.label, chosen.probe.why));
    }
  } catch (error) {
    setupNote(`Couldn't use that ${what}: ${messageOf(error)}`);
  } finally {
    setup.choose.disabled = false;
    dav.connect.disabled = false;
  }
}

setup.choose.onclick = () => void useChoice(chooseFolder(), 'folder');

const dav = {
  form: byId('webdav-form', HTMLFormElement),
  url: byId('dav-url', HTMLInputElement),
  user: byId('dav-user', HTMLInputElement),
  password: byId('dav-password', HTMLInputElement),
  connect: byId('dav-connect', HTMLButtonElement),
};
dav.form.onsubmit = (event) => {
  event.preventDefault();
  const url = parseDavUrl(dav.url.value);
  if (url === null) return setupNote('Enter the WebDAV address, starting with https://.');
  const typed = { url, username: dav.user.value, password: dav.password.value };
  void useChoice(chooseWebdav(typed), 'server', `Synclium needs your permission to reach ${new URL(url).host}.`);
};

function renderSetupResult(): void {
  if (started === null) return;
  const { report } = shown;
  setup.result.hidden = false;
  if (report?.kind !== 'cycle') {
    setup.result.textContent = 'Starting.';
    return;
  }
  const done = started.kind === 'joining' ? `Joined ${started.peers.join(', ')}.` : started.kind === 'first-device' ? `Published ${started.bookmarks} bookmarks.` : '';
  const history = report.history.kind === 'synced' && report.history.deriveDaysLeft > 0 ? ' Catching up on history, newest days first.' : '';
  setup.result.textContent = `${done}${history}`;
}
onShown.push(renderSetupResult);

// ---------- Allow ----------

const allow = { button: byId('allow-button', HTMLButtonElement), result: byId('allow-result', HTMLParagraphElement) };
/** Read when #allow opens, so the click's first await is the permission prompt. */
let allowChoice: StoreChoice | undefined;

async function enterAllow(): Promise<void> {
  allow.button.disabled = true;
  allowChoice = await slots.get('current');
  allow.button.disabled = false;
}

allow.button.onclick = async () => {
  const allowing = allowStore(allowChoice);
  allow.button.disabled = true;
  allow.result.hidden = true;
  try {
    const status = await allowing;
    if (status.access === 'ready') {
      await ask({ kind: 'sync-now' });
      location.hash = '#status';
      return;
    }
    allow.result.replaceChildren(
      status.access === 'not-set-up'
        ? 'Nothing is set up yet. '
        : status.why.kind === 'needs-permission'
          ? `Synclium still can't use ${status.label}. Click Allow access, then allow it in Helium's prompt.`
          : `${failureText(status.label, status.why)} `,
    );
    if (status.access === 'not-set-up' || status.why.kind === 'missing') {
      const link = el('a', 'Choose it again in setup');
      link.href = '#setup';
      allow.result.append(link);
    }
  } catch (error) {
    allow.result.textContent = `Couldn't ask for access: ${messageOf(error)}`;
  } finally {
    allow.button.disabled = false;
  }
  allow.result.hidden = false;
};

// ---------- Status ----------

const status = {
  page: byId('status', HTMLElement),
  text: byId('status-text', HTMLSpanElement),
  when: byId('status-when', HTMLParagraphElement),
  sync: byId('status-sync', HTMLButtonElement),
  action: byId('status-action', HTMLButtonElement),
  check: byId('status-check', HTMLButtonElement),
  map: byId('map', HTMLDivElement),
  self: byId('map-self', HTMLDivElement),
  folder: byId('map-folder', HTMLDivElement),
  peers: byId('map-peers', HTMLUListElement),
  problems: byId('problems', HTMLDivElement),
  profile: byId('status-profile', HTMLParagraphElement),
  warnings: byId('warnings', HTMLUListElement),
};
const facts = {
  bookmarks: [byId('fact-bookmarks', HTMLElement), byId('fact-bookmarks-detail', HTMLSpanElement)],
  history: [byId('fact-history', HTMLElement), byId('fact-history-detail', HTMLSpanElement)],
  folder: [byId('fact-folder', HTMLElement), byId('fact-folder-detail', HTMLSpanElement)],
} as const;
const whenLabel = (t: number) => new Date(t).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });

/** A device-map node: a name, then one muted line under it. */
function node(target: HTMLElement, name: string, sub: string): void {
  target.replaceChildren(el('strong', name), el('span', sub));
}

function setFact([value, detail]: readonly [HTMLElement, HTMLElement], fact: Fact | null): void {
  value.textContent = fact?.value ?? '—';
  detail.textContent = fact?.detail ?? '';
}

function renderStatus(): void {
  const view = viewOf(shown);
  const now = Date.now();
  status.page.dataset.tone = toneOf(view);
  status.text.textContent = statusSentence(view, now);
  status.profile.textContent = profileSentence(shown.profile);
  status.profile.hidden = status.profile.textContent === '';
  const next = primaryAction(view);
  status.action.hidden = next === null;
  status.sync.classList.toggle('primary', next === null);
  if (next !== null) {
    status.action.textContent = next.label;
    status.action.onclick = () => (next.opens === null ? void ask({ kind: 'sync-now' }) : (location.hash = next.opens.slice('app.html'.length)));
  }

  const report = shown.report?.kind === 'cycle' ? shown.report : null;
  status.when.textContent = report === null ? '' : `Last sync ${whenLabel(report.at)}. Checks for changes every few minutes.`;
  node(status.self, report?.name ?? 'This device', 'This device');
  const store = report?.store ?? { access: 'not-set-up' };
  node(status.folder, store.access === 'not-set-up' ? 'No folder' : store.label, 'Sync folder');
  status.folder.classList.toggle('broken', store.access !== 'ready');

  const peers = report?.peers ?? [];
  status.peers.replaceChildren(
    ...(peers.length === 0
      ? [el('li', 'No other devices yet. Pick the same folder in Helium on another device.', 'empty')]
      : [...peers]
          .sort((a, b) => Number(a.idle) - Number(b.idle) || b.lastSeen - a.lastSeen)
          .map((peer) => {
            const item = el('li', '', peer.idle ? 'node idle' : 'node');
            node(item, peer.name, peer.idle ? `Idle, last seen ${ago(now - peer.lastSeen)}` : `Seen ${ago(now - peer.lastSeen)}`);
            return item;
          })),
  );

  setFact(facts.bookmarks, report === null ? null : bookmarksFact(report.bookmarks));
  setFact(facts.history, report === null ? null : historyFact(report.history));
  setFact(facts.folder, report === null ? null : folderFact(report.store));
  status.check.hidden = report === null;

  const warnings = report?.warnings ?? [];
  const nameOf = (device: string) => peers.find((p) => p.device === device)?.name ?? 'Another device';
  status.problems.hidden = warnings.length === 0;
  rows(status.warnings, warnings.map((w) => warningSentence(w, nameOf)), '');
}
onShown.push(renderStatus);
// A sync in flight ends when the worker writes its next report, which re-renders and clears this.
onShown.push(() => {
  status.map.classList.remove('syncing');
  status.sync.disabled = false;
});

status.sync.onclick = async () => {
  status.sync.disabled = true;
  status.map.classList.add('syncing');
  await ask({ kind: 'sync-now' });
};
status.check.onclick = async () => {
  status.check.disabled = true;
  const result = await ask({ kind: 'check-store' });
  status.check.disabled = false;
  const [, detail] = facts.folder;
  detail.textContent =
    result.access === 'ready'
      ? 'Reachable and writable.'
      : result.access === 'failed'
        ? previewSentence({ kind: 'not-ready', store: result })
        : 'Nothing is set up yet.';
};

// ---------- Review ----------

const review = { line: byId('review-line', HTMLParagraphElement), sample: byId('review-sample', HTMLUListElement), apply: byId('apply-deletions', HTMLButtonElement) };

function renderReview(): void {
  const view = viewOf(shown);
  review.apply.hidden = view.kind !== 'review';
  if (view.kind !== 'review') {
    review.line.textContent = 'Nothing is waiting for review.';
    review.sample.replaceChildren();
    return;
  }
  review.line.textContent = `Sync stopped before deleting ${view.removed} of ${nounFor(view.what, view.of)}. If you meant to delete them, apply the deletions. Otherwise restore them in Helium and sync resumes.`;
  rows(review.sample, view.sample, '');
}
onShown.push(renderReview);
review.apply.onclick = async () => {
  review.apply.disabled = true;
  await ask({ kind: 'apply-deletions' });
  location.hash = '#status';
};

// ---------- History ----------

const search = { q: byId('q', HTMLInputElement), results: byId('results', HTMLDivElement) };
const dayLabel = (t: number) => new Date(t).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
const timeLabel = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

async function runSearch(): Promise<void> {
  const query = search.q.value;
  const visits = await ask({ kind: 'search-history', query });
  if (query !== search.q.value) return; // a newer search is on its way
  if (visits.length === 0) {
    search.results.replaceChildren(el('p', query.trim() === '' ? 'Nothing from your other devices yet. Their visits appear here after they sync.' : 'No visits from your other devices match.', 'note'));
    return;
  }
  search.results.replaceChildren(
    ...groupVisits(visits, dayLabel).map((group) => {
      const section = el('div', '', 'group');
      section.append(el('h3', group.deviceName));
      for (const { day, visits: list } of group.days) {
        section.append(el('p', day, 'day'));
        for (const visit of list) {
          const row = el('div', '', 'visit');
          const link = el('a', visit.title || visit.url);
          link.href = visit.url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.title = visit.url;
          row.append(el('time', timeLabel(visit.t)), link, el('span', new URL(visit.url).hostname, 'host'));
          section.append(row);
        }
      }
      return section;
    }),
  );
}

let searchTimer: number | undefined;
search.q.oninput = () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => void runSearch(), 150);
};

// ---------- Extensions ----------

const exts = {
  off: byId('ext-off', HTMLDivElement),
  on: byId('ext-on', HTMLDivElement),
  grant: byId('ext-grant', HTMLButtonElement),
  revoke: byId('ext-revoke', HTMLButtonElement),
  offers: byId('ext-offers', HTMLUListElement),
};
const MANAGEMENT: chrome.permissions.Permissions = { permissions: ['management'] };

async function renderExtensions(): Promise<void> {
  const granted = await chrome.permissions.contains(MANAGEMENT);
  exts.off.hidden = granted;
  exts.on.hidden = !granted;
  if (!granted) return;
  const here = new Set((await chrome.management.getAll()).map((ext) => ext.id));
  const peers = shown.report?.kind === 'cycle' ? shown.report.extensions : [];
  const list = offers(peers, here);
  if (list.length === 0) {
    rows(exts.offers, [], peers.length === 0 ? 'No other device shares its extensions yet. Turn this on there too.' : 'This device has every extension your other devices share.');
    return;
  }
  exts.offers.replaceChildren(
    ...list.map((offer) => {
      const row = el('li', '', 'offer');
      const label = el('span', offer.name);
      label.append(' ', el('span', `on ${offer.on.join(', ')}`, 'on'));
      if (offer.source === 'store') {
        const add = el('a', 'Add');
        add.href = storePage(offer.id);
        add.target = '_blank';
        add.rel = 'noopener noreferrer';
        row.append(label, add);
      } else row.append(label, el('span', offer.source === 'unpacked' ? 'Loaded unpacked there' : 'Not from the Web Store', 'on'));
      return row;
    }),
  );
}
onShown.push(() => void renderExtensions());

// The permission prompt needs this click's gesture, so the request comes first.
exts.grant.onclick = async () => {
  if (await chrome.permissions.request(MANAGEMENT)) await ask({ kind: 'sync-now' });
  await renderExtensions();
};
exts.revoke.onclick = async () => {
  await chrome.permissions.remove(MANAGEMENT);
  await ask({ kind: 'sync-now' });
  await renderExtensions();
};

// ---------- Advanced ----------

const advanced = {
  history: byId('adv-history', HTMLInputElement),
  change: byId('change-folder', HTMLButtonElement),
  forget: byId('forget', HTMLButtonElement),
  deviceId: byId('device-id', HTMLParagraphElement),
  folder: byId('adv-folder', HTMLParagraphElement),
  showKey: byId('show-key', HTMLButtonElement),
  key: byId('adv-key', HTMLElement),
  keyCopy: byId('adv-key-copy', HTMLButtonElement),
};

function renderAdvanced(): void {
  const report = shown.report?.kind === 'cycle' ? shown.report : null;
  advanced.history.disabled = report === null;
  advanced.forget.disabled = report === null;
  if (report !== null) advanced.history.checked = report.history.kind !== 'off';
  advanced.deviceId.textContent = report === null ? 'This device is not set up.' : `${report.name}, device id ${report.device}`;
  advanced.folder.textContent = report === null || report.store.access === 'not-set-up' ? 'Nothing is set up.' : `Syncing through ${report.store.label}.`;
}
onShown.push(renderAdvanced);
advanced.showKey.onclick = async () => {
  const key = await ask({ kind: 'show-key' });
  advanced.key.hidden = false;
  advanced.key.textContent = key === null ? 'This device is not set up.' : formatSyncKey(key);
  advanced.keyCopy.hidden = key === null;
  if (key !== null) advanced.keyCopy.onclick = () => copy(key);
};
advanced.history.onchange = () => void ask({ kind: 'set-history', on: advanced.history.checked });
// Setup offers both kinds of store. Its Start joins the new one as a new device (background.ts `start`). The
// candidate still holds the store in use, so it is cleared first: Start waits for a new choice.
advanced.change.onclick = async () => {
  await slots.clearCandidate();
  location.hash = '#setup';
};
// ---------- Full profile mode (in Advanced) ----------

const pm = {
  line: byId('pm-line', HTMLParagraphElement),
  allow: byId('pm-allow', HTMLDivElement),
  grant: byId('pm-grant', HTMLButtonElement),
  install: byId('pm-install', HTMLDivElement),
  command: byId('pm-command', HTMLElement),
  copy: byId('pm-copy', HTMLButtonElement),
  error: byId('pm-error', HTMLParagraphElement),
  check: byId('pm-check', HTMLButtonElement),
  pick: byId('pm-pick', HTMLDivElement),
  profileRow: byId('pm-profile-row', HTMLLabelElement),
  profile: byId('pm-profile', HTMLSelectElement),
  on: byId('pm-on', HTMLButtonElement),
  off: byId('pm-off', HTMLButtonElement),
};
const NATIVE: chrome.permissions.Permissions = { permissions: ['nativeMessaging'] };
const INSTALL = `helium-sync-companion install --extension-id ${chrome.runtime.id}`;

function renderProfileLine(): void {
  pm.line.textContent = profileSentence(shown.profile);
  pm.line.hidden = pm.line.textContent === '';
}
onShown.push(renderProfileLine);

/** One step at a time: allow, install, pick a profile and turn on, or turn off. Asks the companion for hello. */
async function renderProfileMode(): Promise<void> {
  const setup = await ask({ kind: 'profile-status' });
  const { hello } = setup;
  const compatible = hello !== null && hello.protocol === PROTOCOL_VERSION;
  pm.allow.hidden = setup.permission;
  pm.install.hidden = !setup.permission || compatible;
  pm.pick.hidden = !compatible || setup.on !== null;
  pm.off.hidden = setup.on === null;
  pm.command.textContent = INSTALL;
  pm.error.hidden = setup.error === null && (hello === null || compatible);
  pm.error.textContent =
    hello !== null && !compatible ? `This companion speaks protocol ${hello.protocol}; this extension needs ${PROTOCOL_VERSION}. Install the companion from the same build.` : `The companion didn't answer: ${setup.error ?? ''}`;
  if (!compatible || setup.on !== null) return;
  pm.profile.replaceChildren(...hello.profiles.map((p) => new Option(p.name === p.dir ? p.dir : `${p.name} (${p.dir})`, p.dir)));
  pm.profileRow.hidden = hello.profiles.length < 2;
  pm.on.disabled = hello.profiles.length === 0;
  if (hello.profiles.length === 0) {
    pm.error.hidden = false;
    pm.error.textContent = `The companion found no Helium profiles in ${hello.userDataDir}.`;
  }
}

// The permission prompt needs this click's gesture, so the request comes first.
pm.grant.onclick = async () => {
  await chrome.permissions.request(NATIVE);
  await renderProfileMode();
};
pm.copy.onclick = () => void navigator.clipboard.writeText(INSTALL);
pm.check.onclick = () => void renderProfileMode();
pm.on.onclick = async () => {
  pm.on.disabled = true;
  await ask({ kind: 'set-profile-mode', dir: pm.profile.value });
  pm.on.disabled = false;
  await renderProfileMode();
};
pm.off.onclick = async () => {
  await ask({ kind: 'set-profile-mode', dir: null });
  await renderProfileMode();
};

advanced.forget.onclick = async () => {
  if (!confirm("Forget this device? Its files leave the sync folder. Bookmarks and history in Helium stay.")) return;
  await ask({ kind: 'forget-this-device' });
  location.hash = '#setup';
};

// ---------- Routing ----------

const enter: { readonly [S in Section]?: () => Promise<void> } = { setup: enterSetup, allow: enterAllow, history: runSearch, extensions: renderExtensions, advanced: renderProfileMode };

function route(): void {
  const hash = location.hash.slice(1);
  const section: Section = isSection(hash) ? hash : viewOf(shown).kind === 'setup' ? 'setup' : 'status';
  for (const name of SECTIONS) byId(name, HTMLElement).hidden = name !== section;
  for (const link of document.querySelectorAll('nav a')) {
    if (link.getAttribute('href') === `#${section}`) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  void enter[section]?.();
}

chrome.storage.local.onChanged.addListener((changes) => {
  const change = changes[SHOWN_KEY];
  if (change === undefined) return;
  shown = shownFrom(change.newValue);
  for (const render of onShown) render();
});

search.q.value = new URLSearchParams(location.search).get('q') ?? '';
window.addEventListener('hashchange', route);
for (const render of onShown) render();
route();
setInterval(renderStatus, 30_000);
