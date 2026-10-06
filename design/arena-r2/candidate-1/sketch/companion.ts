// Opt-in file mode: the boundary to the native companion. The only module in the extension that knows it
// exists. The engine, the store, and history.ts never import this file.
//
// The companion is a separate download (macOS .pkg / Linux tarball), installed only by users who turn on
// "Put other devices' history into Helium's own history, with real visit times" in app.html#advanced.
// It installs two things that share one state dir:
//   host   native messaging host `net.imput.helium_sync` (manifest in <user-data-dir>/NativeMessagingHosts/,
//          allowed_origins = the CWS extension id). Helium spawns it on connectNative while it runs. It
//          receives the peer-visit mirror below and writes it to disk. It never touches the profile.
//   agent  launchd / systemd user agent. When Helium is closed (round 1's host + pid + binary check), it
//          reconciles Helium's History SQLite to the mirror: insert mirrored visits it has not inserted, at
//          their real visit_time; delete visits it inserted whose shard no longer has them. It records what it
//          inserted, so it never deletes a visit Helium made. It never writes Bookmarks and never writes the store.
//
// Why a mirror instead of giving the companion the store: File System Access never reveals the folder's
// path, and a second store reader would need the store format, device ids, and rollback rules. The mirror
// is desired state per shard, so it is idempotent: resending a shard is harmless, and a crash on either side
// converges on the next exchange.
//
// The one coupling back into sync: history.ts skips local visits that some peer already published
// (HistoryDb.knownFromPeers), so visits the agent wrote are never republished as this device's own.
import type { DeviceId } from './model.ts';
import type { DayKey, Visit } from './history.ts';
import type { HistoryDb } from './ports.ts';

/** Extension -> host. Desired state per peer shard. */
export type ToCompanion =
  | { readonly kind: 'hello'; readonly extensionVersion: string }
  | { readonly kind: 'shard'; readonly device: DeviceId; readonly day: DayKey; readonly rev: number; readonly visits: readonly Visit[] }
  | { readonly kind: 'drop'; readonly device: DeviceId; readonly day: DayKey };

/** The agent's last reconcile of History SQLite, shown in app.html#advanced. */
export type AgentRun = { readonly at: number; readonly inserted: number; readonly removed: number };

/** Host -> extension. Under the 1 MB native-messaging limit by construction. */
export type FromCompanion =
  | {
      readonly kind: 'hello';
      readonly companionVersion: string;
      /** (device/day) -> rev the host holds, so the extension sends only what changed. */
      readonly held: { readonly [deviceDay: string]: number };
      readonly lastApply: AgentRun | null;
    }
  | { readonly kind: 'ack'; readonly device: DeviceId; readonly day: DayKey; readonly rev: number };

export type CompanionStatus =
  | { readonly kind: 'off' }                         // optional permission not granted, or toggle off
  | { readonly kind: 'not-installed' }               // connectNative failed: show the download link
  | { readonly kind: 'ok'; readonly lastApply: AgentRun | null };

/**
 * Called by background.ts after every cycle. Returns { kind: 'off' } at once unless the user opted in
 * (chrome.permissions.contains nativeMessaging, and the toggle in app.html#advanced). connectNative, hello, send shards whose rev differs from `held`, drops for
 * shards the index no longer has, disconnect. Opened per cycle, not held open, so the worker can sleep.
 */
export async function mirrorToCompanion(_db: HistoryDb): Promise<CompanionStatus> {
  throw new Error('not implemented');
}
