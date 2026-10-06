// Companion extension service worker (MV3). Deliberately dumb: identity, a native port, and dispatch of
// bridge calls into each registry entry's browser half. No sync logic ships here, so engine fixes ship via
// npm instead of a store review. It changes only when a data type's browser half or permissions change.
//
// manifest.json is generated (extension/manifest.ts): fixed `key` (pins the extension id the native host
// manifest allows), permissions = registry.extensionPermissions, background.service_worker = this file.

import { registry } from '../datatypes/registry.ts';
import type { ToExtension, ToHost } from '../bridge/native.ts';

export const HOST_NAME = 'dev.helium_sync.host';

/** Minted once per profile with crypto.randomUUID(); chrome.storage.local, so it dies with the extension. */
async function deviceId(): Promise<string> {
  throw new Error('not implemented');
}

/**
 * connectNative(HOST_NAME) and send hello. The open port keeps the worker alive (observed >= 9 min, no drop).
 * On disconnect (host not installed yet, host crashed): retry on the next 'reconnect' alarm (1 min), so
 * installing extension and host in either order converges without a browser restart.
 */
async function connect(): Promise<void> {
  // facets = Object.fromEntries(Object.values(registry).map(t => [t.name, t.browser(chrome)]))
  // port.onMessage(call)  -> facets[type].ops[op](args) -> post { t: 'result', id, ok, value | error }
  // port.onMessage(uninstall-self) -> chrome.management.uninstallSelf({ showConfirmDialog: true })
  // for each facet.changes event -> post { t: 'changed', type }  (triggers only; host diffs snapshots)
  void registry;
  const _in: ToExtension | undefined = undefined;
  const _out: ToHost | undefined = undefined;
  throw new Error('not implemented');
}

chrome.runtime.onInstalled.addListener(() => void connect());
chrome.runtime.onStartup.addListener(() => void connect());
chrome.alarms.create('reconnect', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => void connect()); // no-op when already connected
