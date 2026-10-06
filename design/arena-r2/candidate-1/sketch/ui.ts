// The two extension pages and what they show. Vanilla DOM; no framework for two small pages.
//   popup.html  (action popup)  status at a glance, "Sync now", and buttons that open app.html
//   app.html    (options page, opens in a tab)  setup, folder access, status detail, history search, advanced
// Anything that needs a user gesture for File System Access happens in app.html, never the popup: the
// native picker and Chromium's permission bubble take focus, the popup closes, and a request tied to a
// closed frame is cancelled.
import type { SyncReport } from './engine.ts';
import type { RemoteVisit } from './ports.ts';

/**
 * Page -> worker protocol, one entry per message: request fields and reply. Single source for both types
 * below. Pages render status from chrome.storage.local; replies exist for the setup flow and search.
 */
type Protocol = {
  'sync-now': { req: {}; res: SyncReport };
  /** After the user reviewed a blocked mass delete in app.html. */
  'apply-deletions': { req: {}; res: SyncReport };
  'search-history': { req: { readonly query: string }; res: readonly RemoteVisit[] };
  'forget-this-device': { req: {}; res: null };
};
export type UiMessage = { [K in keyof Protocol]: { readonly kind: K } & Protocol[K]['req'] }[keyof Protocol];
export type UiReply<M extends UiMessage> = Protocol[M['kind']]['res'];

/** Typed sendMessage. The one place pages talk to the worker. */
export function ask<M extends UiMessage>(_message: M): Promise<UiReply<M>> {
  throw new Error('not implemented');
}

/**
 * What the popup shows, derived from the last report. One variant per thing the user can do something about.
 * Order of precedence: setup, folder access, blocked, then ok.
 */
export type StatusView =
  | { readonly kind: 'setup' }                                           // "Set up Helium Sync"          [Set up]
  | { readonly kind: 'allow'; readonly folder: string }                  // "Paused until you allow access to <folder>" [Allow access]
  | { readonly kind: 'missing'; readonly folder: string }                // "Can't find <folder>"         [Choose folder]
  | { readonly kind: 'review'; readonly removed: number }                // "Paused: would delete N bookmarks" [Review]
  | {
      readonly kind: 'ok';
      readonly lastSync: number;
      readonly devices: number;                                          // "Synced 2 min ago with 2 other devices"
      readonly waiting: number;                                          // bookmark changes an interrupted apply left
      readonly problems: number;                                         // warnings, listed in app.html
    };

export function viewOf(_report: SyncReport | undefined): StatusView {
  throw new Error('not implemented');
}

/** '' when ok, '!' for allow / missing / review / setup. The only always-visible signal. */
export function badgeFor(_view: StatusView): { readonly text: '' | '!'; readonly title: string } {
  throw new Error('not implemented');
}

/*
 * app.html routes by hash, so the popup and the worker can deep-link:
 *   #setup   onInstalled opens this. Step 1 "Choose a folder you already sync (iCloud Drive, Dropbox,
 *            Syncthing)" [Choose folder] -> chooseFolder(). Step 2 shows "New sync folder" or "Joining
 *            conan-mbp, conan-mini", a device name field prefilled from the platform ("Mac"), [Start syncing]
 *            -> confirm(name), ask({ kind: 'sync-now' }). Step 3 renders the report: "Added 14, matched 498".
 *   #allow   [Allow access to "Helium Sync"] -> allowFolder(), then ask({ kind: 'sync-now' }).
 *   #status  devices with last seen, warnings in plain words, pending changes, [Sync now].
 *   #review  the removed bookmark labels; [Apply these deletions] -> ask({ kind: 'apply-deletions' }).
 *   #history search box over peers' visits (ask({ kind: 'search-history' })), grouped by device and day.
 *   #advanced "Change folder", "Forget this device", and the companion opt-in (companion.ts).
 */
export function mountApp(_root: HTMLElement): void {
  throw new Error('not implemented');
}

/** Renders viewOf(report) and re-renders on chrome.storage.onChanged. Reading storage never wakes the worker. */
export function mountPopup(_root: HTMLElement): void {
  throw new Error('not implemented');
}
