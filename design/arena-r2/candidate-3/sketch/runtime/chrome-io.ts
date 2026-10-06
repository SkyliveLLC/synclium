// The worker's three small chrome.* edges, kept out of worker.ts so it reads as wiring only.
import type { Settings, Status } from './rpc.ts';
import type { Wake } from './scheduler.ts';

/** chrome.storage.local['settings'], parsed at this boundary. Missing or malformed becomes the default (store: null). */
export function readSettings(): Promise<Settings> {
  throw new Error('not implemented');
}

/** chrome.storage.local['status']. Also sets the action badge: "!" for needs-access, a count for blocked, empty otherwise. */
export function writeStatus(_next: Status): Promise<void> {
  throw new Error('not implemented');
}

/** The `resume` alarm. `arm` rounds up to chrome.alarms' 30 s minimum. */
export const chromeWake: Wake = {
  arm: () => {
    throw new Error('not implemented');
  },
  disarm: () => {
    throw new Error('not implemented');
  },
};
