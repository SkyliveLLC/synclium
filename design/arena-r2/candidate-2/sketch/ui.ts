// The two extension pages and the message protocol between them and the worker. Pages are thin: they render
// UiStorage (chrome.storage.local + onChanged) and send one of these messages when the user clicks.
//
// Popup (toolbar icon)
//   not configured   "Set up sync" -> options page
//   configured       store host and device name; per type one line ("Bookmarks: in sync, 512 items, 2 min ago",
//                    "History: 3 devices, pulled 4 min ago, backfilling 2024-08"); peers with last seen;
//                    buttons Sync now, Pair another device, Synced history, Settings.
//   trouble          the Blocked or StoreFailure in one sentence plus the one action that fixes it
//                    (Grant permission, Open settings, Allow mass delete). Badge '!' while any type is blocked.
//
// Options page (full tab; permissions.request needs a click, and the form is long for a popup)
//   Setup            tab "Join with a pairing code" (paste, Join) or tab "Connect storage"
//                    (preset, server, username, app password with the provider's help link, Connect). Then device name. Done.
//   Status           the same lines as the popup, with the full change list of the last cycle.
//   Devices          peers; "Forget this device" for idle ones is deliberately absent (no device deletes another's files).
//   Synced history   search box, date range, device filter, rows from `viewSink().search`. Reads IndexedDB directly.
//   Settings         poll interval; "Add synced URLs to this device's address-bar suggestions" (off, explains the
//                    untitled now-stamped entries); Advanced: "Write synced history into Helium's history database
//                    when Helium quits" with the companion install command, Enable, and HostState;
//                    "Delete my synced history"; Disconnect / Disconnect and forget this device.
//   Pair             the pairing code with Copy, the "include password" toggle, and the one-sentence warning.
import type { SyncReport } from './engine.ts';
import type { PairingCode, StoreConfig } from './adapters/store-config.ts';
import type { HostState } from './adapters/native-host.ts';
import type { Settings } from './background.ts';

export type Message =
  | { readonly kind: 'connect'; readonly config: StoreConfig }
  | { readonly kind: 'sync-now' }
  | { readonly kind: 'sync-now'; readonly force: true }
  | { readonly kind: 'pairing-code'; readonly includeSecret: boolean }
  | { readonly kind: 'settings'; readonly settings: Settings }
  | { readonly kind: 'native-host'; readonly action: 'enable' | 'disable' | 'status' }
  | { readonly kind: 'disconnect'; readonly forget: boolean };

export type Reply =
  | { readonly kind: 'ok' }
  | { readonly kind: 'report'; readonly report: SyncReport }
  | { readonly kind: 'pairing-code'; readonly code: PairingCode }
  | { readonly kind: 'host'; readonly state: HostState }
  | { readonly kind: 'error'; readonly message: string };

/** The one place a report becomes sentences. Exhaustive over TypeOutcome, Blocked, StoreFailure, and HostState. */
export function describe(_report: SyncReport | null, _settings: Settings): readonly StatusLine[] {
  throw new Error('not implemented');
}
export type StatusLine = {
  readonly subject: 'store' | 'bookmarks' | 'history' | 'devices';
  readonly text: string;
  readonly tone: 'ok' | 'working' | 'trouble';
  readonly action: Message | null;
};
