// What the popup and the setup page render, as pure functions of (Settings, Status). The pages are thin
// DOM over these, so every state the user can see is a variant here that tests can enumerate.
import type { SyncReport, TypeOutcome } from '../engine.ts';
import type { Settings, Status } from '../runtime/rpc.ts';

export type PopupView =
  /** No store chosen. One button opens setup.html in a tab (a popup closes when the folder picker steals focus). */
  | { readonly kind: 'setup' }
  /** The folder grant lapsed. Sync is paused; one button opens setup.html, where `reconnect` is a click. */
  | { readonly kind: 'needs-access'; readonly folder: string }
  | { readonly kind: 'store-unreachable'; readonly detail: string }
  | {
      readonly kind: 'ready';
      readonly headline: 'Synced' | 'Syncing' | 'Catching up';
      /** "2 min ago", "just now". Rendered from `last.at`. */
      readonly lastSyncAt: number | null;
      readonly rows: readonly TypeRow[];
      readonly devices: readonly { readonly name: string; readonly lastSeen: number; readonly idle: boolean }[];
      /** Bug-class failure to show under the headline. */
      readonly error: string | null;
    };

export type TypeRow = {
  readonly type: string;
  readonly state: 'synced' | 'pending' | 'blocked' | 'off';
  readonly text: string;
  /** Present only on a blocked mass delete. The popup shows "Yes, sync the deletion" and sends 'confirm-mass-delete'. */
  readonly confirm?: 'mass-delete';
};

export function popupView(_settings: Settings, _status: Status): PopupView {
  // settings.store === null                      -> setup
  // last.store.kind === 'needs-access'           -> needs-access
  // last.store.kind === 'unreachable'            -> store-unreachable
  // otherwise rows from last.types, headline from cycle.state and last.complete
  throw new Error('not implemented');
}

export function describe(_type: string, _outcome: TypeOutcome): TypeRow {
  // synced   bookmarks: "412 bookmarks". history: "Remote history searchable in the extension (3 devices)".
  // pending  quota: "Adding 4,588 bookmarks, Helium allows about 100 a minute." budget: "Catching up, newest days first."
  // blocked  mass-delete: "This device just lost 61% of its history. Sync the deletion to other devices?"
  throw new Error('not implemented');
}

/**
 * The setup page's second screen, after a folder is picked. It runs one dry-run cycle and shows what joining will
 * do, which turns the silent first-join adoption into something the user can see and trust.
 */
export type JoinPreview =
  | { readonly kind: 'first-device'; readonly bookmarks: number }
  | { readonly kind: 'joining'; readonly peers: readonly string[]; readonly bookmarks: { readonly matched: number; readonly toPublish: number; readonly toAdd: number } };

export function joinPreview(_report: SyncReport): JoinPreview {
  throw new Error('not implemented');
}
