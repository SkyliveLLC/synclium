// What the two extension pages say, and how they talk to the worker. Pure, apart from `ask` and `readShown`,
// so the view model runs in a Node test. The DOM lives in app.ts and popup.ts.
//   popup.html  status at a glance, [Sync now], and the one button the status calls for
//   app.html    (options page, a tab) setup, status detail, history search, extensions, review, advanced
//               (full profile mode's opt-in lives in advanced)
// Anything that needs a user gesture (the folder picker, a folder re-grant, a WebDAV host permission, the
// optional `management` and `nativeMessaging` grants) happens in app.html, never the popup: the picker and
// Chromium's permission bubbles take focus, the popup closes, and a request tied to a closed frame is cancelled.
//
// Status flows one way. The worker writes `Shown` to chrome.storage.local; pages render it and re-render on
// storage.onChanged. Pages never run the engine and never write its state; they ask.
import type { JoinPreview, LogOutcome, RegisterOutcome, SyncReport, Warning } from './engine.ts';
import type { StoreFailure, StoreStatus } from './ports.ts';
import type { HelloReply } from './profile-mode.ts';
import type { RemoteVisit } from './local.ts';
import type { Platform } from './store-format.ts';
import type { SyncKey } from './sync-key.ts';

type Empty = Record<never, never>;

/** The device name setup suggests. */
export const DEVICE_NAMES = { mac: 'Mac', win: 'Windows PC', linux: 'Linux PC' } as const satisfies Record<Platform, string>;

export type StartResult =
  | { readonly kind: 'started' }
  | { readonly kind: 'not-ready'; readonly store: StoreStatus }
  /** Devices in the folder sync under another key. */
  | { readonly kind: 'wrong-key' };

/** Page -> worker protocol: request fields and reply, one entry per message. Single source for both types below. */
type Protocol = {
  'sync-now': { req: Empty; res: null };
  /** Dry run against the `candidate` store with the key setup holds: a fresh one, or the one the user pasted. */
  preview: { req: { readonly key: SyncKey }; res: JoinPreview };
  /** Promote `candidate`, mint the DeviceId, request the first cycle. Refused unless the candidate probes ok and the key matches. */
  start: { req: { readonly name: string; readonly historyOn: boolean; readonly key: SyncKey }; res: StartResult };
  /** This device's sync key, for adding another device. Null before setup. */
  'show-key': { req: Empty; res: SyncKey | null };
  'set-history': { req: { readonly on: boolean }; res: null };
  /** After the user reviewed a blocked mass delete. Bumps the durable `applyDeletions` ask. */
  'apply-deletions': { req: Empty; res: null };
  'check-store': { req: Empty; res: StoreStatus };
  'search-history': { req: { readonly query: string }; res: readonly RemoteVisit[] };
  'forget-this-device': { req: Empty; res: null };
  /** Full profile mode's steps for Advanced. Asks the companion for `hello` on the spot when the grant is there. */
  'profile-status': { req: Empty; res: ProfileSetup };
  /** A profile directory turns full profile mode on for it; null turns it off. Requests a sync. */
  'set-profile-mode': { req: { readonly dir: string | null }; res: null };
};

/** What Advanced needs to show the next step: grant, install, pick a profile, or on. `error` says why `hello` failed. */
export type ProfileSetup = {
  readonly permission: boolean;
  readonly hello: HelloReply | null;
  readonly error: string | null;
  readonly on: { readonly dir: string } | null;
};
export type UiMessage = { [K in keyof Protocol]: { readonly kind: K } & Protocol[K]['req'] }[keyof Protocol];
export type UiReply<M extends UiMessage> = Protocol[M['kind']]['res'];

/** sendMessage carries a reply or the handler's error, so `ask` rejects instead of resolving undefined. */
export type Wire<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

/** Typed sendMessage. The one place pages talk to the worker. Wakes it if it sleeps. */
export async function ask<M extends UiMessage>(message: M): Promise<UiReply<M>> {
  const wire: Wire<UiReply<M>> = await chrome.runtime.sendMessage(message);
  if (!wire.ok) throw new Error(wire.message);
  return wire.value;
}

// ---------- What the worker shows ----------

export const SHOWN_KEY = 'shown';

/**
 * Full profile mode as the last cycle found it. `unavailable`: the mode is on here but the companion could not
 * be used, so the three types sat the cycle out. `pending` counts staged changes waiting for Helium to quit.
 */
export type ProfileStatus =
  | { readonly kind: 'off' }
  | { readonly kind: 'unavailable'; readonly why: 'no-permission' | 'no-companion' | 'protocol-mismatch' }
  | { readonly kind: 'on'; readonly profile: string; readonly pending: number; readonly webData: 'ok' | 'unsupported' };

/** chrome.storage.local[SHOWN_KEY]. `failure` is a cycle that threw; the scheduler retries it with backoff. */
export type Shown = {
  readonly report: SyncReport | null;
  readonly failure: { readonly at: number; readonly message: string } | null;
  readonly profile: ProfileStatus;
};
export const nothingShown: Shown = { report: null, failure: null, profile: { kind: 'off' } };

type Stored = Shown & { readonly app: string };

/**
 * Written only by the worker, tagged with the app version that wrote it. A value from this version has this
 * build's shape; one from before an update reads as nothing shown until the next cycle rewrites it.
 */
export function shownFrom(value: unknown): Shown {
  const current = (v: unknown): v is Stored => typeof v === 'object' && v !== null && 'app' in v && v.app === chrome.runtime.getManifest().version;
  return current(value) ? value : nothingShown;
}

export async function readShown(): Promise<Shown> {
  return shownFrom((await chrome.storage.local.get(SHOWN_KEY))[SHOWN_KEY]);
}

export function storedShown(shown: Shown): { readonly [SHOWN_KEY]: Stored } {
  return { [SHOWN_KEY]: { ...shown, app: chrome.runtime.getManifest().version } };
}

/**
 * What the popup shows. One variant per thing the user can act on. The same variants cover every P7 rung and
 * WebDAV; only which failure appears, and how often, changes.
 */
export type StatusView =
  | { readonly kind: 'setup' }
  /** The last cycle threw. Not the user's to fix; shown so a stuck sync is never silent. */
  | { readonly kind: 'error'; readonly message: string }
  /** "Paused: <sentence for the failure>" with one button from actionFor. Local edits keep committing. */
  | { readonly kind: 'paused'; readonly label: string; readonly why: StoreFailure }
  /** "Another copy of this profile syncs as this device." */
  | { readonly kind: 'clash' }
  | { readonly kind: 'review'; readonly what: Synced; readonly removed: number; readonly of: number; readonly sample: readonly string[] }
  /** A peer writes a format of `what` this version cannot read. It waits for an update. */
  | { readonly kind: 'outdated'; readonly what: Synced }
  | {
      readonly kind: 'ok';
      readonly lastSync: number;
      /** Live peers, idle ones excluded. */
      readonly devices: number;
      /** A backfill walk, a pull, or a bookmark apply continues in the next wake. */
      readonly catchingUp: boolean;
      /** Warnings, listed in app.html#status. */
      readonly problems: number;
    };

/** The register types, in the words the pages use: one, many, and the subject of a sentence. */
export type Synced = 'bookmarks' | 'reading-list' | 'settings' | 'search-engines' | 'addresses';
const WORDS = {
  bookmarks: ['bookmark', 'bookmarks', 'Bookmarks are'],
  'reading-list': ['reading list entry', 'reading list entries', 'The reading list is'],
  settings: ['setting', 'settings', 'Settings are'],
  'search-engines': ['search engine', 'search engines', 'Search engines are'],
  addresses: ['address', 'addresses', 'Addresses are'],
} as const satisfies Record<Synced, readonly [string, string, string]>;
export function nounFor(what: Synced, n: number): string {
  const [one, many] = WORDS[what];
  return plural(n, one, many);
}

export function viewOf({ report, failure }: Shown): StatusView {
  if (failure !== null && (report === null || failure.at >= report.at)) return { kind: 'error', message: failure.message };
  if (report === null) return { kind: 'setup' };
  switch (report.kind) {
    case 'needs-setup':
      return { kind: 'setup' };
    case 'identity-clash':
      return { kind: 'clash' };
    case 'cycle':
      break;
    default: {
      const unreachable: never = report;
      return unreachable;
    }
  }
  const { store, history } = report;
  if (store.access === 'failed') return { kind: 'paused', label: store.label, why: store.why };
  if (store.access === 'not-set-up') return { kind: 'paused', label: '', why: { kind: 'missing' } };
  const registers = [
    ['bookmarks', report.bookmarks],
    ['reading-list', report.readingList],
    ['settings', report.settings],
    ['search-engines', report.searchEngines],
    ['addresses', report.addresses],
  ] as const satisfies readonly (readonly [Synced, RegisterOutcome])[];
  let pending = false;
  for (const [what, outcome] of registers) {
    switch (outcome.kind) {
      case 'blocked': {
        const { why } = outcome;
        return why.kind === 'mass-delete' ? { kind: 'review', what, removed: why.removed.removed, of: why.of, sample: why.removed.sample } : { kind: 'outdated', what };
      }
      case 'pending':
        pending = true;
        break;
      case 'synced':
      case 'off':
        break;
      default: {
        const unreachable: never = outcome;
        return unreachable;
      }
    }
  }
  return {
    kind: 'ok',
    lastSync: report.at,
    devices: report.peers.filter((peer) => !peer.idle).length,
    catchingUp: !report.complete || pending || (history.kind === 'synced' && history.deriveDaysLeft > 0),
    problems: report.warnings.length,
  };
}

export type AppPage = 'app.html#setup' | 'app.html#allow' | 'app.html#status' | 'app.html#review' | 'app.html#history' | 'app.html#extensions' | 'app.html#advanced';

/** `opens: null` means "ask the worker to sync now". */
export type Action = { readonly label: string; readonly opens: AppPage | null };

/** The one button for each failure. Exhaustive, so a new StoreFailure fails to compile until it has one. */
export function actionFor(why: StoreFailure): Action {
  switch (why.kind) {
    case 'needs-permission':
      return { label: 'Allow access', opens: 'app.html#allow' };
    case 'missing':
      return { label: 'Choose folder', opens: 'app.html#setup' };
    case 'unreachable':
    case 'rejected':
      return { label: 'Retry', opens: null };
    default: {
      const unreachable: never = why;
      return unreachable;
    }
  }
}

/** The button the popup offers beside [Sync now], if the status calls for one. */
export function primaryAction(view: StatusView): Action | null {
  switch (view.kind) {
    case 'setup':
      return { label: 'Set up', opens: 'app.html#setup' };
    case 'paused':
      return actionFor(view.why);
    case 'clash':
      return { label: 'Forget this device', opens: 'app.html#advanced' };
    case 'review':
      return { label: 'Review', opens: 'app.html#review' };
    case 'error':
    case 'outdated':
    case 'ok':
      return null;
    default: {
      const unreachable: never = view;
      return unreachable;
    }
  }
}

export function ago(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function failureSentence(label: string, why: StoreFailure): string {
  const where = label === '' ? 'the sync folder' : label;
  switch (why.kind) {
    case 'needs-permission':
      return `Paused until you allow access to ${where}.`;
    case 'missing':
      return `Can't find ${where}.`;
    case 'unreachable':
      return `Paused: can't reach ${where} (${why.detail}).`;
    case 'rejected':
      return `Paused: ${where} refused a write (${why.detail}).`;
    default: {
      const unreachable: never = why;
      return unreachable;
    }
  }
}

/** One sentence for the popup, the badge tooltip, and the status page. */
export function statusSentence(view: StatusView, now: number): string {
  switch (view.kind) {
    case 'setup':
      return 'Not set up yet.';
    case 'error':
      return `Sync failed and will retry: ${view.message}`;
    case 'paused':
      return failureSentence(view.label, view.why);
    case 'clash':
      return 'Another copy of this profile syncs as this device.';
    case 'review':
      return `Paused: this would delete ${nounFor(view.what, view.removed)}.`;
    case 'outdated':
      return `${WORDS[view.what][2]} paused: another device runs a newer Synclium. Update this one.`;
    case 'ok': {
      const others = view.devices === 0 ? 'no other devices yet' : plural(view.devices, 'other device');
      return `Synced ${ago(now - view.lastSync)} with ${others}.${view.catchingUp ? ' Catching up.' : ''}`;
    }
    default: {
      const unreachable: never = view;
      return unreachable;
    }
  }
}

/** Full profile mode's line on the status page and in Advanced. '' while the mode is off. */
export function profileSentence(status: ProfileStatus): string {
  switch (status.kind) {
    case 'off':
      return '';
    case 'unavailable':
      switch (status.why) {
        case 'no-permission':
          return 'Full profile mode is paused: Synclium is not allowed to talk to the companion.';
        case 'no-companion':
          return "Full profile mode is paused: the companion isn't installed or didn't answer.";
        case 'protocol-mismatch':
          return 'Full profile mode is paused: the companion comes from another Synclium version. Install the matching one.';
        default: {
          const unreachable: never = status.why;
          return unreachable;
        }
      }
    case 'on': {
      const waiting = status.pending > 0 ? `${plural(status.pending, 'change')} will be written after Helium quits.` : 'Full profile mode is on. Nothing is waiting for Helium to quit.';
      return status.webData === 'ok' ? waiting : `${waiting} Search engines and addresses wait for a Synclium update that knows this Helium version.`;
    }
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}

/**
 * '' when nothing needs the user, '!' otherwise. The only always-visible signal. The tooltip carries no time,
 * because it is written once per cycle and read whenever.
 */
export function badgeFor(view: StatusView): { readonly text: '' | '!'; readonly title: string } {
  if (view.kind !== 'ok') return { text: '!', title: `Synclium: ${statusSentence(view, Date.now())}` };
  const others = view.devices === 0 ? 'no other devices yet' : plural(view.devices, 'other device');
  return { text: '', title: `Synclium: syncing with ${others}.` };
}

/** The colour of the status dot and the device map's links. `busy` is healthy but still catching up. */
export type Tone = 'idle' | 'ok' | 'busy' | 'attention' | 'error';

export function toneOf(view: StatusView): Tone {
  switch (view.kind) {
    case 'setup':
      return 'idle';
    case 'ok':
      return view.catchingUp ? 'busy' : 'ok';
    case 'error':
      return 'error';
    case 'paused':
    case 'clash':
    case 'review':
    case 'outdated':
      return 'attention';
    default: {
      const unreachable: never = view;
      return unreachable;
    }
  }
}

/** One cell of the dashboard's facts row: a short state, then a sentence of detail. */
export type Fact = { readonly value: string; readonly detail: string };

const changes = ({ added, updated, removed }: { added: number; updated: number; removed: number }): string =>
  [added > 0 ? `${added} added` : '', updated > 0 ? `${updated} changed` : '', removed > 0 ? `${removed} removed` : ''].filter((part) => part !== '').join(', ');

export function bookmarksFact(outcome: RegisterOutcome): Fact {
  switch (outcome.kind) {
    case 'synced': {
      const from = changes(outcome.applied);
      if (from !== '') return { value: 'Up to date', detail: `Last sync: ${from} from other devices.` };
      if (outcome.stamped > 0) return { value: 'Up to date', detail: `Last sync shared ${plural(outcome.stamped, 'edit')} from here.` };
      return { value: 'Up to date', detail: 'Nothing changed in the last sync.' };
    }
    case 'pending':
      return { value: 'Applying', detail: `${changes(outcome.pending) || 'A few changes'} left. Continues on the next sync.` };
    case 'blocked':
      return outcome.why.kind === 'mass-delete'
        ? { value: 'Waiting for review', detail: `Would delete ${outcome.why.removed.removed} of ${outcome.why.of}.` }
        : { value: 'Waiting for update', detail: 'Another device writes a newer format.' };
    case 'off':
      return { value: 'Off', detail: 'Not synced on this device.' };
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
}

export function historyFact(outcome: LogOutcome): Fact {
  switch (outcome.kind) {
    case 'off':
      return { value: 'Off', detail: 'Turn it on in Settings to search other devices.' };
    case 'synced': {
      const parts = [
        `${plural(outcome.publishedDays, 'day')} shared from here`,
        outcome.unpublishedDays > 0 ? `${outcome.unpublishedDays} waiting for the folder` : '',
        outcome.pulledDays > 0 ? `${outcome.pulledDays} updated from other devices` : '',
      ];
      const detail = `${parts.filter((part) => part !== '').join(', ')}.`;
      return outcome.deriveDaysLeft > 0 ? { value: 'Catching up', detail: `${plural(outcome.deriveDaysLeft, 'day')} left to read. ${detail}` } : { value: 'Up to date', detail };
    }
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
}

export function folderFact(store: StoreStatus): Fact {
  switch (store.access) {
    case 'ready':
      return { value: store.label, detail: 'Connected.' };
    case 'failed':
      return { value: store.label, detail: failureSentence(store.label, store.why) };
    case 'not-set-up':
      return { value: 'No folder', detail: 'Choose one in setup.' };
    default: {
      const unreachable: never = store;
      return unreachable;
    }
  }
}

/** Setup's second screen: what Start will do, before anything is written. */
export function previewSentence(preview: JoinPreview): string {
  switch (preview.kind) {
    case 'not-ready':
      return preview.store.access === 'failed' ? failureSentence(preview.store.label, preview.store.why) : 'Choose Google Drive, a folder, or a WebDAV server first.';
    case 'first-device':
      return `New sync folder. ${plural(preview.bookmarks, 'bookmark')} will be shared.`;
    case 'needs-key':
      return `${plural(preview.devices, 'device')} already ${preview.devices === 1 ? 'syncs' : 'sync'} here. Enter the sync key from one of them.`;
    case 'joining': {
      const { matched, toAdd, toPublish } = preview.bookmarks;
      return `Joining ${preview.peers.join(', ')}. ${plural(matched, 'bookmark')} already match, ${toAdd} will be added here, ${toPublish} will be shared.`;
    }
    default: {
      const unreachable: never = preview;
      return unreachable;
    }
  }
}

/** What setup's key step says under the key. `entered` is what the key field holds: nothing, not a key, or a key. */
export function keyNote(preview: JoinPreview, entered: 'nothing' | 'not-a-key' | 'key'): string {
  switch (preview.kind) {
    case 'not-ready':
      return '';
    case 'first-device':
      return 'Only devices with this key can read the folder. You can show it again under Advanced.';
    case 'needs-key':
      if (entered === 'nothing') return 'On one of your other devices, open Synclium, then Settings, then Show sync key.';
      if (entered === 'not-a-key') return "That isn't a sync key. It starts with HSK- and has 13 groups of 4 characters.";
      return "That key doesn't match the devices in this folder.";
    case 'joining':
      return 'The key matches.';
    default: {
      const unreachable: never = preview;
      return unreachable;
    }
  }
}

/** Plain words for each warning on the status page. */
export function warningSentence(warning: Warning, nameOf: (device: string) => string): string {
  switch (warning.kind) {
    case 'rollback':
      return `${nameOf(warning.peer)} went back to an older copy of its files. Its newer copy stands.`;
    case 'not-yet':
      return `${nameOf(warning.peer)}: ${warning.file} has not finished syncing yet.`;
    case 'unknown-codec':
      return `${nameOf(warning.peer)} uses a file format this version can't read (${warning.codec}).`;
    case 'newer-version':
      return `${nameOf(warning.peer)} runs a newer Synclium; ${warning.file} is skipped until this one updates.`;
    case 'other-key':
      return 'A device in the sync folder uses a different sync key. It is ignored.';
    case 'foreign-file':
      return `An unexpected file "${warning.name}" is in the sync folder. It is ignored.`;
    case 'rejoined':
      return 'This device was away for a long time and joined again as a new device.';
    default: {
      const unreachable: never = warning;
      return unreachable;
    }
  }
}

export type VisitGroup = { readonly deviceName: string; readonly days: readonly { readonly day: string; readonly visits: readonly RemoteVisit[] }[] };

/** Peers' visits for the History tab: by device, then by local calendar day, keeping the search's newest-first order. */
export function groupVisits(visits: readonly RemoteVisit[], dayLabel: (t: number) => string): readonly VisitGroup[] {
  const byDevice = new Map<string, { deviceName: string; days: Map<string, RemoteVisit[]> }>();
  for (const visit of visits) {
    let group = byDevice.get(visit.device);
    if (group === undefined) byDevice.set(visit.device, (group = { deviceName: visit.deviceName, days: new Map() }));
    const day = dayLabel(visit.t);
    const list = group.days.get(day);
    if (list === undefined) group.days.set(day, [visit]);
    else list.push(visit);
  }
  return [...byDevice.values()].map(({ deviceName, days }) => ({ deviceName, days: [...days].map(([day, list]) => ({ day, visits: list })) }));
}
