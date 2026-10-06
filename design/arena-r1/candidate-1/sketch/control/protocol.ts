// The frontend API. Every frontend (CLI now; extension popup and desktop app later) talks to a running host
// through this and nothing else. One host per Helium profile with the companion installed; each listens on
// its own socket, so "all devices on this machine" = every live socket in the run dir.

import type { SyncOutcome } from '../engine/engine.ts';
import type { DeviceId } from '../engine/model.ts';
import type { TransportConfig } from '../transports/folder.ts';

export type ControlRequest =
  | { readonly op: 'status' }
  | { readonly op: 'sync' }
  /** Sent by `setup` after writing config, so an already-running host binds without a browser restart. */
  | { readonly op: 'reload-config' }
  | { readonly op: 'uninstall'; readonly forget: boolean };

export type HostStatus = {
  readonly device: DeviceId;
  readonly label: string;
  readonly extensionVersion: string;
  readonly store: TransportConfig | null;
  readonly syncing: boolean;
  readonly last: SyncOutcome | null;
};

/** Response type per request, so a client call is typed end to end. */
export type ControlResponse = {
  readonly status: HostStatus;
  readonly sync: SyncOutcome;
  readonly 'reload-config': HostStatus;
  readonly uninstall: null;
};

export interface ControlClient {
  readonly device: DeviceId;
  send<R extends ControlRequest>(request: R): Promise<ControlResponse[R['op']]>;
  close(): void;
}

/** Connect to every live host on this machine. Stale sockets (host gone) are unlinked and skipped. */
export async function connectAll(runDir: string): Promise<readonly ControlClient[]> {
  throw new Error('not implemented');
}

/**
 * Socket path for a device. Unix socket paths cap near 104 bytes on macOS, so use the first 12 chars of the
 * DeviceId. Windows: `\\.\pipe\helium-sync-<id>`. Mode 0600: only this user can drive the browser through it.
 */
export function socketPath(runDir: string, device: DeviceId): string {
  throw new Error('not implemented');
}
