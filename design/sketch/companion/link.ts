// Opt-in file mode, extension side. Recommended for v1.1; the boundary is fixed in v1. The extension's whole
// view of the companion is one sink decorator and one status type. The engine, the store, and log-cycle.ts
// never import this folder.
//
// Opt-in is two explicit steps in app.html#advanced: grant the optional `nativeMessaging` permission (inside
// the click), and install the companion (a download the user runs). The page says plainly that the companion
// writes Helium's History database while Helium is closed, with a backup first, and that Helium's README asks
// for its storage to change only through its APIs. File mode never writes Bookmarks.
//
// The port stays open for the browser session. An open native port keeps the worker alive (P2), and its close
// is how the host learns Helium quit. A port that drops for another reason (worker killed, extension reloaded)
// looks the same to the host; its applier then finds Helium running and waits, so a false close costs nothing.
import type { Visit } from '../history.ts';
import type { LogSink } from '../ports.ts';
import type { Receipt } from './protocol.ts';

export type CompanionStatus =
  | { readonly kind: 'off' }
  /** Permission granted but connectNative failed: show the download link. */
  | { readonly kind: 'not-installed' }
  | { readonly kind: 'connected'; readonly pending: number; readonly lastApply: Receipt | null };

export interface HostLink {
  status(): Promise<CompanionStatus>;
  /** Idempotent. Failures are swallowed: the index still holds the visits, and the backlog resend repairs. */
  stage(visits: readonly Visit[]): Promise<void>;
}

/**
 * null unless the user opted in (chrome.permissions.contains nativeMessaging and the toggle). Reuses the
 * session's open port if one exists. On hello with `needsBacklog`, stages every indexed peer visit once.
 */
export function connectCompanion(): Promise<HostLink | null> {
  throw new Error('not implemented');
}

/**
 * The whole file-mode upgrade: `put` runs the base sink (the index, searchable now), then stages the visits for
 * the host to insert at the next quit. `drop` touches only the base: the companion never deletes a visit.
 * Visits it inserted come back through chrome.history with the peer's key, and the echo rule keeps them from
 * being republished as this device's own.
 */
export function withCompanion(base: LogSink<Visit>, link: HostLink): LogSink<Visit> {
  return {
    async put(from, day, events) {
      await base.put(from, day, events);
      await link.stage(events);
    },
    drop: (device, day) => base.drop(device, day),
  };
}
