// The two extension pages and what they show. Vanilla DOM; no framework for two small pages.
//   popup.html  status at a glance, [Sync now], and buttons that open app.html
//   app.html    (options page, a tab) setup, folder access, status detail, history search, advanced
// Anything that needs a user gesture for File System Access happens in app.html, never the popup: the native
// picker and Chromium's permission bubble take focus, the popup closes, and a request tied to a closed frame
// is cancelled.
//
// Status flows one way. The worker writes the last SyncReport to chrome.storage.local; pages render it and
// re-render on storage.onChanged. Pages never run the engine and never write its state; they ask.
import type { JoinPreview, SyncReport } from './engine.ts';
import type { StoreFailure, StoreStatus } from './ports.ts';
import type { RemoteVisit } from './local.ts';

/** Page -> worker protocol: request fields and reply, one entry per message. Single source for both types below. */
type Protocol = {
  'sync-now': { req: {}; res: null };
  /** Dry run against the `candidate` folder. Setup's second screen. */
  preview: { req: {}; res: JoinPreview };
  /** Promote `candidate`, mint the DeviceId, request the first cycle. The report arrives through storage. */
  start: { req: { readonly name: string; readonly historyOn: boolean }; res: null };
  'set-history': { req: { readonly on: boolean }; res: null };
  /** After the user reviewed a blocked mass delete. Bumps the durable `applyDeletions` ask. */
  'apply-deletions': { req: {}; res: null };
  'check-store': { req: {}; res: StoreStatus };
  'search-history': { req: { readonly query: string }; res: readonly RemoteVisit[] };
  'forget-this-device': { req: {}; res: null };
};
export type UiMessage = { [K in keyof Protocol]: { readonly kind: K } & Protocol[K]['req'] }[keyof Protocol];
export type UiReply<M extends UiMessage> = Protocol[M['kind']]['res'];

/** Typed sendMessage. The one place pages talk to the worker. Wakes it if it sleeps. */
export function ask<M extends UiMessage>(_message: M): Promise<UiReply<M>> {
  throw new Error('not implemented');
}

/**
 * What the popup shows, derived from the last report. One variant per thing the user can act on. The same
 * variants cover every P7 rung and the WebDAV fallback; only which failure appears, and how often, changes.
 */
export type StatusView =
  | { readonly kind: 'setup' }
  /** "Paused: <sentence for the failure>" with one button from actionFor. Local edits keep committing. */
  | { readonly kind: 'paused'; readonly label: string; readonly why: StoreFailure }
  /** "Another copy of this profile syncs as this device." [Forget this device] */
  | { readonly kind: 'clash' }
  /** "Paused: would delete N bookmarks." [Review] */
  | { readonly kind: 'review'; readonly removed: number }
  | {
      readonly kind: 'ok';
      readonly lastSync: number;
      /** "Synced 2 min ago with 2 other devices" */
      readonly devices: number;
      /** "Catching up": a backfill walk, a pull, or a bookmark apply continues in the next wake. */
      readonly catchingUp: boolean;
      /** Warnings, listed in app.html#status. */
      readonly problems: number;
    };

export function viewOf(_report: SyncReport | undefined): StatusView {
  throw new Error('not implemented');
}

export type Action = { readonly label: string; readonly opens: 'app.html#allow' | 'app.html#setup' | null };

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

/** '' when ok, '!' when the user can act. The only always-visible signal. */
export function badgeFor(_view: StatusView): { readonly text: '' | '!'; readonly title: string } {
  throw new Error('not implemented');
}

/*
 * app.html routes by hash, so the popup and the worker can deep-link:
 *   #setup    onInstalled opens this.
 *             1. "Choose a folder you already sync: iCloud Drive, Dropbox, Syncthing." [Choose folder] -> chooseFolder().
 *             2. ask('preview'): "New sync folder" or "Joining conan-mbp. 498 bookmarks already match, 14 will be
 *                added here, 37 will be shared." Device name prefilled ("Mac"). A checked "Sync history" box
 *                with one sentence: "Bookmarks and the last 90 days of history are stored unencrypted in this
 *                folder." [Start] -> ask('start').
 *             3. Renders the first report from storage: "Published 512 bookmarks. Catching up on history."
 *   #allow    [Allow access to "Helium Sync"] -> allowFolder(), then ask('sync-now').
 *   #status   devices with last seen, warnings in plain words, [Sync now], [Check folder] -> ask('check-store').
 *   #review   the removed bookmark labels; [Apply these deletions] -> ask('apply-deletions').
 *   #history  search over peers' visits, grouped by device and day.
 *   #advanced "Change folder", "Sync history" toggle, "Forget this device", and the companion opt-in.
 */
export function mountApp(_root: HTMLElement): void {
  throw new Error('not implemented');
}

export function mountPopup(_root: HTMLElement): void {
  throw new Error('not implemented');
}
