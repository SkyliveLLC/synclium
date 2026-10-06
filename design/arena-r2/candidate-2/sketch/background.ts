// The MV3 service worker. A frontend, not part of the engine: it decides WHEN to sync and wires adapters.
// The engine decides WHAT. Everything here must survive the worker being killed at any line.
//
// Triggers
//   alarm 'poll'            every 5 min (periodInMinutes; Chrome's floor is 0.5)      sync()
//   alarm 'publish'         one-shot, set 30 s after a bookmark event as the backstop   sync()
//   bookmarks.on*           in-memory 3 s debounce -> sync(); ignored while applying     fast publish of local edits
//   history.onVisited       nothing but a `dirty` flag in chrome.storage.session        the poll collects
//   runtime.onInstalled     create alarms, navigator.storage.persist(), open options page when not configured
//   runtime.onStartup       create alarms (they persist, but a reinstall or crash may have lost them)
//   popup 'sync-now'        sync({ discover: true })
//
// Single flight. Every trigger runs `runSync`, which takes navigator.locks 'helium-sync:engine' with
// ifAvailable. If the lock is held, it sets `rerun` and returns; the holder loops once more when it finishes.
// The lock is per origin, so a future options-page caller is serialised too. A worker death releases the
// lock and the engine's ordering makes the half-done cycle converge on the next trigger.
//
// Lifetime. Chromium (>= 110) keeps the worker alive while an extension API call or a fetch is in flight,
// and resets the 30 s idle timer on each event, so a cycle of a few seconds never needs a keepalive. The
// history backfill is chunked per day for the same reason. There is no WebSocket or long poll: a 304 on
// each peer's manifest every 5 minutes is the whole steady-state cost.
import type { Engine, SyncOptions, SyncReport } from './engine.ts';
import type { StoreConfig } from './adapters/store-config.ts';
import type { HostState } from './adapters/native-host.ts';

export type Settings = {
  readonly deviceName: string;
  readonly pollMinutes: number;
  /** chrome-history.ts sink 2. Default off. */
  readonly omniboxHints: boolean;
  /** native-host.ts. Default off. Only true after `enable()` reported `connected`. */
  readonly nativeHost: boolean;
};
export const defaultSettings: Settings = { deviceName: '', pollMinutes: 5, omniboxHints: false, nativeHost: false };

/** chrome.storage.local, the UI's half of the state. `report` is written after every cycle; the popup renders it. */
export type UiStorage = {
  readonly config: StoreConfig | null;
  readonly settings: Settings;
  readonly report: SyncReport | null;
  readonly host: HostState | null;
};

/** Reads UiStorage, builds adapters, returns the engine. Null until setup finished. Rebuilt when `config` changes. */
export function buildEngine(): Promise<Engine | null> {
  throw new Error('not implemented');
}

export function runSync(_opts: SyncOptions): Promise<void> {
  throw new Error('not implemented');
}

/**
 * Setup, called from the options page through `Message`:
 *   1. requestHostPermission(url) inside the click  2. storeFor(config).probe()  3. save config
 *   4. runSync({ discover: true })  5. the first report is the join (adoption, then merge).
 * Idempotent: rerunning with the same config repeats the probe and sync and changes nothing.
 */
export function connect(_config: StoreConfig): Promise<{ readonly kind: 'ok' } | { readonly kind: 'denied' } | { readonly kind: 'failed'; readonly report: string }> {
  throw new Error('not implemented');
}

/** Removes alarms, config, report. `forget` also runs engine.forget() so peers stop waiting on this device. */
export function disconnect(_opts: { readonly forget: boolean }): Promise<void> {
  throw new Error('not implemented');
}
