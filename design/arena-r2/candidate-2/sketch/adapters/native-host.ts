// The opt-in file mode. The only module that calls chrome.runtime.connectNative, and the whole boundary
// between the extension and Helium's profile files. In v1 it is a history sink and nothing else:
// bookmarks already apply with full fidelity through chrome.bookmarks, so the companion's one job is to
// write remote visits into History SQLite with their real visit_time, which no extension API can do (P2).
//
// Enabling it (options page, "Advanced"):
//   1. chrome.permissions.request({ permissions: ['nativeMessaging'] })      optional_permissions in the manifest
//   2. the user installs the companion once (`npx helium-sync-host install` writes
//      <user-data-dir>/NativeMessagingHosts/net.imput.helium_sync.json with allowed_origins = this extension's CWS id)
//   3. `hello` succeeds -> setting on. Until then the Advanced section shows the install command and a Retry button.
// Disabling it drops the permission; the engine never knew.
//
// Companion lifecycle (P2: Helium spawns the host on connectNative and closes its stdin on quit):
//   - while connected, `stage` appends visits to <local app dir>/staged-visits.jsonl. The open port also keeps
//     the service worker alive, which is harmless: with the companion on, the worker is alive while Helium is.
//   - on stdin end (Helium quitting) the host spawns a detached child and exits. The child waits for SingletonLock
//     to clear (P1's host + pid + binary check), opens History, inserts visits it does not already hold by
//     (url, visit_time) with visit_source = SYNCED, updates urls.visit_count/last_visit_time, truncates the
//     staged file, exits. If Helium starts again before the lock clears, the child gives up and the staged
//     file waits for the next quit.
//   - the imported visits appear to chrome.history after restart; the echo rule in chrome-history.ts drops them
//     because their keys were marked ingested when they were staged.
import type { HistorySink } from './chrome-history.ts';

export const HOST_NAME = 'net.imput.helium_sync';

/** Messages extension -> host. Wire shape of the companion protocol; private to this module. */
type HostRequest =
  | { readonly kind: 'hello'; readonly extensionVersion: string }
  | { readonly kind: 'stage'; readonly visits: readonly StagedVisit[] }
  | { readonly kind: 'status' };
type HostReply =
  | { readonly kind: 'hello'; readonly hostVersion: number; readonly profileDir: string }
  | { readonly kind: 'staged'; readonly accepted: number }
  | { readonly kind: 'status'; readonly staged: number; readonly lastImportAt: number | null; readonly lastImported: number };
type StagedVisit = { readonly url: string; readonly title: string; readonly t: number; readonly transition: string };

export type HostState =
  | { readonly kind: 'connected'; readonly hostVersion: number; readonly staged: number; readonly lastImportAt: number | null }
  | { readonly kind: 'not-installed' }
  | { readonly kind: 'permission-missing' }
  | { readonly kind: 'incompatible'; readonly hostVersion: number };

export interface NativeHost extends HistorySink {
  state(): Promise<HostState>;
  /** The Advanced section's Enable button. Requests the permission inside the click, then `hello`. */
  enable(): Promise<HostState>;
  disable(): Promise<void>;
}

export function nativeHost(): NativeHost {
  throw new Error('not implemented');
}

function _send(_req: HostRequest): Promise<HostReply> {
  throw new Error('not implemented');
}
