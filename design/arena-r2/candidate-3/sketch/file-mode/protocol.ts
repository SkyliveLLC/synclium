// Wire contract between the extension and the opt-in native host (`helium-sync-host`). Private to file-mode/:
// nothing outside this directory imports it (per the interface-depth rule: no wire types on the public surface).
//
// What file mode is. A history-only writer for the one thing the API cannot do: put a visit into Helium's
// History database at its real time. Bookmarks never use it, because chrome.bookmarks is complete and the
// browser must be running to show them anyway. The engine, the store, and the merge do not change.
//
// The host is a Node process Helium spawns through native messaging (P2: discovered at
// `<user-data-dir>/NativeMessagingHosts/<name>.json`). It has two jobs and they never overlap in time:
//
//   1. WHILE HELIUM RUNS   (host is alive)  Accept `stage`. Write staged visits to the host's own state dir, never to
//                                            the profile. Touch nothing Helium owns.
//   2. AFTER HELIUM QUITS  (host got EOF)    Before exiting, spawn a detached applier and exit. The applier waits until
//                                            Helium is provably closed, then imports the staged visits.
//
// The applier is round 1's file-profile.ts, shrunk to one job. Its rules are unchanged:
//   - "Closed" = SingletonLock host matches, pid is dead or is not the Helium binary (a SIGKILLed Helium leaves the symlink).
//   - Copy `History` to a timestamped backup first. Keep the last 5.
//   - Open writable, insert in one transaction, re-check run state, commit. If Helium appeared, roll back and retry later.
//   - Insert only visits with no existing (url, visit_time) row, creating `urls` rows as needed, and recompute
//     visit_count, typed_count, and last_visit_time for touched urls. Re-running inserts nothing, so a kill is safe.
//   - Write a receipt to the state dir.
// On the next browser start the host answers `hello` with the receipts, and the extension shows "imported N visits".
//
// Why nothing else has to coordinate: visit ids are hashes of (url, time). After the import, chrome.history returns
// the same ids the corpus already holds, so ChromeHistory.read sees one visit, not two, and the corpus drops its copy.
// A lost receipt, a half-run import, or a second device importing the same visit all converge the same way.
import type { Via } from '../types/history.ts';

export const HOST_NAME = 'net.helium_sync.host';

export type WireVisit = { readonly url: string; readonly title: string; readonly time: number; readonly via: Via };

export type ToHost =
  | { readonly t: 'hello'; readonly extension: string }
  /** Idempotent and cumulative: the host dedupes by (url, time). The extension may resend everything after a reconnect. */
  | { readonly t: 'stage'; readonly visits: readonly WireVisit[] };

export type FromHost =
  | { readonly t: 'hello'; readonly host: string; readonly profileDir: string; readonly receipts: readonly Receipt[] }
  | { readonly t: 'staged'; readonly pending: number }
  | { readonly t: 'error'; readonly message: string };

export type Receipt = { readonly at: number; readonly imported: number; readonly alreadyPresent: number; readonly backup: string };
