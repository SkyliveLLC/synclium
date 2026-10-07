// app.html, the options page. Routes by hash, so the popup and the worker can deep-link:
//   #setup     store, device name, history choice, join preview, Start
//   #allow     re-grant folder access after the grant lapsed (Chromium asks again after a restart)
//   #status    the dashboard: status, a map of devices around the folder, bookmarks/history/folder facts, problems
//   #review    a blocked mass delete and [Apply these deletions]
//   #history   search over peers' visits, grouped by device and day
//   #advanced  settings: history toggle, change folder, forget this device
// The folder picker and the permission prompt need the click's gesture, so chooseFolder and allowFolder run
// first thing in their click handlers.
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
  previewSentence,
  primaryAction,
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
import { allowFolder, chooseFolder } from './folder-store.ts';
import type { StoreFailure } from './ports.ts';

const SECTIONS = ['setup', 'allow', 'status', 'review', 'history', 'advanced'] as const;
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
  name: byId('name', HTMLInputElement),
  historyOn: byId('history-on', HTMLInputElement),
  preview: byId('preview', HTMLParagraphElement),
  start: byId('start', HTMLButtonElement),
  result: byId('setup-result', HTMLParagraphElement),
};
let started: JoinPreview | null = null;

async function enterSetup(): Promise<void> {
  if (setup.name.value === '') setup.name.value = DEVICE_NAMES[parsePlatform((await chrome.runtime.getPlatformInfo()).os)];
  const preview = await ask({ kind: 'preview' });
  const ready = preview.kind !== 'not-ready';
  setup.chooseNote.hidden = ready;
  setup.storeLabel.hidden = !ready;
  if (ready) setup.storeLabel.textContent = `Store: ${preview.label}`;
  setup.preview.hidden = !ready;
  setup.preview.textContent = previewSentence(preview);
  setup.start.disabled = !ready;
  setup.start.onclick = async () => {
    setup.start.disabled = true;
    const result = await ask({ kind: 'start', name: setup.name.value, historyOn: setup.historyOn.checked });
    if (result.kind === 'not-ready') {
      setup.preview.textContent = previewSentence({ kind: 'not-ready', store: result.store });
      return;
    }
    started = preview;
    renderSetupResult();
  };
}

/** Picker, prompt, and probe. `ok` means the folder is now the candidate; on `failed`, `note` says why. */
async function choose(note: HTMLParagraphElement): Promise<'ok' | 'cancelled' | 'failed'> {
  try {
    const chosen = await chooseFolder();
    if (chosen.kind === 'cancelled') return 'cancelled';
    if (chosen.probe.kind === 'ok') return 'ok';
    note.textContent = failureText(chosen.label, chosen.probe.why);
  } catch (error) {
    note.textContent = `Couldn't use that folder: ${messageOf(error)}`;
  }
  note.hidden = false;
  return 'failed';
}

setup.choose.onclick = async () => {
  const outcome = await choose(setup.preview);
  if (outcome === 'ok') await enterSetup();
  if (outcome === 'failed') setup.start.disabled = true;
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

allow.button.onclick = async () => {
  allow.button.disabled = true;
  allow.result.hidden = true;
  try {
    const status = await allowFolder();
    if (status.access === 'ready') {
      await ask({ kind: 'sync-now' });
      location.hash = '#status';
      return;
    }
    allow.result.replaceChildren(
      status.access === 'not-set-up'
        ? 'No folder is set up yet. '
        : status.why.kind === 'needs-permission'
          ? `Synclium still can't use ${status.label}. Click Allow access, then choose "Allow on every visit" in Helium's prompt.`
          : `${failureText(status.label, status.why)} `,
    );
    if (status.access === 'not-set-up' || status.why.kind === 'missing') {
      const link = el('a', 'Choose the folder again');
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
        : 'No folder is set up.';
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
  review.line.textContent = `Sync stopped before deleting ${view.removed} of ${view.of} bookmarks. If you meant to delete them, apply the deletions. Otherwise restore them in Helium and sync resumes.`;
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

// ---------- Advanced ----------

const advanced = {
  history: byId('adv-history', HTMLInputElement),
  change: byId('change-folder', HTMLButtonElement),
  changeResult: byId('change-result', HTMLParagraphElement),
  forget: byId('forget', HTMLButtonElement),
  deviceId: byId('device-id', HTMLParagraphElement),
  folder: byId('adv-folder', HTMLParagraphElement),
};

function renderAdvanced(): void {
  const report = shown.report?.kind === 'cycle' ? shown.report : null;
  advanced.history.disabled = report === null;
  advanced.forget.disabled = report === null;
  if (report !== null) advanced.history.checked = report.history.kind !== 'off';
  advanced.deviceId.textContent = report === null ? 'This device is not set up.' : `${report.name}, device id ${report.device}`;
  advanced.folder.textContent = report === null || report.store.access === 'not-set-up' ? 'No folder is set up.' : `Syncing through ${report.store.label}.`;
}
onShown.push(renderAdvanced);
advanced.history.onchange = () => void ask({ kind: 'set-history', on: advanced.history.checked });
// Start, on the setup screen this opens, joins the new folder as a new device (background.ts `start`).
advanced.change.onclick = async () => {
  advanced.changeResult.hidden = true;
  if ((await choose(advanced.changeResult)) === 'ok') location.hash = '#setup';
};
advanced.forget.onclick = async () => {
  if (!confirm("Forget this device? Its files leave the sync folder. Bookmarks and history in Helium stay.")) return;
  await ask({ kind: 'forget-this-device' });
  location.hash = '#setup';
};

// ---------- Routing ----------

const enter: { readonly [S in Section]?: () => Promise<void> } = { setup: enterSetup, history: runSearch };

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
