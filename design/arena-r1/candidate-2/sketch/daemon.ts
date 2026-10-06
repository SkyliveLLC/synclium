// The frontend that answers "is the browser closed?" so the user never has to. Runs under launchd / systemd
// --user. Owns three watchers and a debounce; everything else is `engine.sync()`.
//
// State machine
//   RUNNING  profile Bookmarks changed  -> debounce 5s -> sync({apply:'never'})   (outbound only)
//            store changed              -> sync({apply:'never'})                   (pull; report.pending shown)
//            lock gone / pid dead       -> CLOSED
//   CLOSED   on entry: wait pid gone + 2s quiet -> sync()                           (outbound + inbound apply)
//            store changed              -> sync()                                   (apply immediately)
//            lock appears + pid alive   -> RUNNING  (an in-flight write throws BrowserStarted and stops)
//   either   control 'sync'             -> sync()   'status' -> engine.status()   'stop' -> exit
//
// The daemon is a client of the engine, not part of it. A desktop app can replace this file.

import type { Engine, SyncReport } from './engine.ts';
import type { ProfileDir } from './profile.ts';
import type { Store } from './store.ts';

export class Daemon {
  constructor(
    private readonly engine: Engine,
    private readonly profile: ProfileDir,
    private readonly store: Store,
    private readonly controlSocket: string,
  ) {}

  /** Resolves when `signal` aborts or a 'stop' request arrives. Never throws out of a sync; errors go to the report log. */
  run(signal: AbortSignal): Promise<void> {
    throw new Error('not implemented');
  }
}

/** Newline-delimited JSON over a unix socket (named pipe on Windows). The whole frontend protocol. */
export type ControlRequest = { readonly cmd: 'status' } | { readonly cmd: 'sync' } | { readonly cmd: 'stop' };
export type ControlResponse =
  | { readonly ok: true; readonly report: SyncReport }
  | { readonly ok: true; readonly stopping: true }
  | { readonly ok: false; readonly error: string };

export interface ControlClient {
  request(req: ControlRequest): Promise<ControlResponse>;
  close(): void;
}

/** null when no daemon is listening; callers fall back to running the engine inline. */
export function connectControl(socketPath: string): Promise<ControlClient | null> {
  throw new Error('not implemented');
}

export type ServicePlatform = 'darwin' | 'linux';

/**
 * darwin: ~/Library/LaunchAgents/net.imput.helium-sync.plist, RunAtLoad + KeepAlive, runs `helium-sync daemon`.
 * linux:  ~/.config/systemd/user/helium-sync.service, WantedBy=default.target.
 * win32:  TODO (Task Scheduler at logon); `init --no-daemon` is the v1 answer there.
 * Idempotent: rewrites the unit and reloads it.
 */
export function installService(platform: ServicePlatform, binPath: string): Promise<void> {
  throw new Error('not implemented');
}
export function uninstallService(platform: ServicePlatform): Promise<void> {
  throw new Error('not implemented');
}
