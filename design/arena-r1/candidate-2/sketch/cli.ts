// `helium-sync` entry point. node:util parseArgs, six commands, no runtime deps. The CLI is a thin shell: it
// builds the Engine from local config and either asks a running daemon or runs a pass inline.

import type { SyncReport } from './engine.ts';

export type Command =
  /** Register this device, push, install the daemon, run the first pass. Second device: same command, same folder. */
  | { readonly cmd: 'init'; readonly folder: string; readonly name?: string; readonly profile?: string; readonly daemon: boolean }
  /** One pass now. Applies to the profile if Helium is closed. Works with or without a daemon. */
  | { readonly cmd: 'sync' }
  /** Store, devices, Helium run state, per-type pending counts. */
  | { readonly cmd: 'status' }
  /** Full pass (waits for Helium to be closed if it is quitting), then exec Helium with the optional url. */
  | { readonly cmd: 'open'; readonly url?: string }
  /** `--list` or restore a backup by timestamp. Refuses while Helium is running. */
  | { readonly cmd: 'restore'; readonly list: boolean; readonly at?: string }
  /** Long-running; invoked by launchd/systemd, not by users. */
  | { readonly cmd: 'daemon' }
  /** Remove the service and local state. Leaves the store and the profile alone. */
  | { readonly cmd: 'uninstall' };

export function parseCommand(argv: readonly string[]): Command {
  throw new Error('not implemented');
}

/** Human output for `sync`, `status`, `init`. The same SyncReport the daemon logs and the desktop app renders. */
export function formatReport(report: SyncReport): string {
  throw new Error('not implemented');
}

/**
 * init:    locateProfile -> initLocalState -> Engine.sync -> installService -> print report
 * sync/status: connectControl ?? inline Engine
 * open:    inline Engine.sync (apply) -> spawn Helium binary with url, detached
 * restore: openForWrite (null -> "quit Helium first") -> restoreBackup
 */
export async function main(argv: readonly string[]): Promise<number> {
  throw new Error('not implemented');
}
