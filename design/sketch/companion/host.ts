// Opt-in file mode, host side: a Node process Helium spawns through native messaging (P2: manifest at
// `<user-data-dir>/NativeMessagingHosts/net.helium_sync.companion.json`, allowed_origins = the CWS id). Its
// two jobs never overlap in time, and neither involves a launchd or systemd agent:
//
//   1. While Helium runs (stdin open): accept `stage`, append to the host's own state dir. Touch nothing Helium owns.
//   2. On stdin EOF: spawn a detached applier and exit. The applier is round 1's file adapter shrunk to one table:
//        - wait until Helium is provably closed (runState: SingletonLock host matches, pid dead or not the Helium
//          binary; the link alone lies after SIGKILL)
//        - one applier at a time: a pid lockfile in the state dir, stale when its pid is dead
//        - copy History to a timestamped backup (keep 5)
//        - open writable; in one transaction insert every staged (url, visit_time) with no existing row, at its
//          real time, visit_source SYNCED; create `urls` rows as needed; recompute visit_count and last_visit_time
//          for touched urls
//        - re-check runState; Helium running -> roll back and wait again; else commit
//        - write a receipt, truncate what it applied from staging
//      Rerunning inserts nothing, so a kill at any point converges. It never deletes, and never writes Bookmarks.
// The host is Node code. These signatures avoid node types so the sketch compiles with one tsconfig.
import type { Receipt, StagedVisit } from './protocol.ts';

export type HeliumPaths = { readonly userDataDir: string; readonly profile: string };

export type RunState = { readonly kind: 'running'; readonly pid: number } | { readonly kind: 'closed' };

/** Round 1's run-state check (P1). */
export function runState(_paths: HeliumPaths): Promise<RunState> {
  throw new Error('not implemented');
}

/** Job 1. Reads native-messaging frames from stdin until EOF, then spawns the detached applier. */
export function serve(_stateDir: string): Promise<void> {
  throw new Error('not implemented');
}

/** Job 2, detached. Resolves with a receipt once staged visits are committed; null when nothing was staged. */
export function applyStaged(_paths: HeliumPaths, _stateDir: string): Promise<Receipt | null> {
  throw new Error('not implemented');
}

export function readStaged(_stateDir: string): Promise<readonly StagedVisit[]> {
  throw new Error('not implemented');
}
