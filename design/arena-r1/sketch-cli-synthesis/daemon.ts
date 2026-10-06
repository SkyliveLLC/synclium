// A frontend, not part of the engine. Decides WHEN to sync. The engine decides WHAT.
// Runs as a launchd or systemd user agent installed by `init`. Zero steady-state commands.
//
//   RUNNING   Bookmarks changed     debounce 5 s, sync           (read-only session, publishes local edits)
//             store changed         debounce 3 s, sync           (pulls, reports pending)
//             run state closed      wait 2 s of file quiet, then CLOSED
//   CLOSED    on entry              sync                         (offline session, applies pending)
//             store changed         debounce 3 s, sync           (applies at once)
//             run state running     RUNNING                      (an in-flight replace returns helium-started)
//   either    every 15 min          sync                         (cloud folder events are unreliable)
//
// Single-flight. A trigger during a run schedules exactly one follow-up run.
import type { Engine } from './engine.ts';
import type { HeliumPaths, RunState } from './adapters/file-profile.ts';
import type { Store } from './ports.ts';

export type Trigger = 'helium-closed' | 'bookmarks-changed' | 'store-changed' | 'poll';

export type DaemonDeps = {
  readonly engine: Engine;
  readonly helium: HeliumPaths;
  readonly store: Store;
  readonly log: (line: string) => void;
};

export type DaemonHandle = {
  readonly state: () => RunState;
  stop(): Promise<void>;
  /** Settles when stopped. A failed sync is logged, never thrown. */
  readonly done: Promise<void>;
};

export function startDaemon(_deps: DaemonDeps): DaemonHandle {
  throw new Error('not implemented');
}

/** Windows has no v1 agent. `init` there prints that sync runs on `helium-sync sync` only. */
export type ServicePlatform = 'darwin' | 'linux';

/**
 * darwin  ~/Library/LaunchAgents/net.imput.helium-sync.plist, RunAtLoad + KeepAlive, runs `<node> <cli> daemon`.
 * linux   ~/.config/systemd/user/helium-sync.service, WantedBy=default.target.
 * Converges. Rewrites the unit only when it differs, then reloads. The node path is pinned, so a node
 * version switch breaks the agent until `init` runs again (`status` says so).
 */
export function installService(_platform: ServicePlatform, _entry: { readonly node: string; readonly cli: string }): Promise<void> {
  throw new Error('not implemented');
}
export function uninstallService(_platform: ServicePlatform): Promise<void> {
  throw new Error('not implemented');
}
