// The native host. Helium spawns it when the companion calls connectNative (on browser start), and it lives
// exactly as long as that port. It is the sync daemon: no launchd/systemd unit, no login item.
// Lifetime == browser lifetime is the point: the browser's data only changes while the browser runs.
//
// Shell only: wires bridge + config + transport + engine, decides WHEN to sync. The engine decides WHAT.

import { openBridge } from '../bridge/native.ts';
import { createEngine } from '../engine/engine.ts';
import { registry } from '../datatypes/registry.ts';
import { openTransport } from '../transports/folder.ts';
import { fileReplicaStore, loadConfig, resolvePaths } from './local.ts';

export type Triggers = {
  /** After a browser change event; coalesces bursts (our own realize also fires events: one no-op rerun). */
  readonly changeDebounceMs: number; // 1_000
  /** After a store watch hint. */
  readonly storeDebounceMs: number; // 2_000
  /** Safety net for cloud folders whose fs events are unreliable. */
  readonly pollMs: number; // 60_000
};

/**
 * Entry point when argv[2] is `chrome-extension://<id>/` (how Chromium launches native hosts).
 *  1. bridge = openBridge(stdin, stdout); hello = await bridge.hello
 *  2. claim socketPath(run, hello.device): if a live host answers, tell it to exit (worker restart race);
 *     the bound socket is the per-device singleton, so one engine writes one device's blob
 *  3. config = loadConfig(); null -> serve control as "unconfigured" until `reload-config`
 *  4. engine = createEngine({ self: hello.device, label, types: registry, browser: bridge.browser,
 *                            transport: openTransport(config.store), replicas: fileReplicaStore(paths) })
 *  5. sync now; then on bridge.onChanged / transport.watch / poll -> engine.sync() (single-flight)
 *  6. control server: status | sync | reload-config | uninstall (bridge.uninstallExtension + local cleanup)
 *  7. await bridge.closed -> close socket, exit 0. No final sync: the browser is already gone, and any
 *     unsynced edit is still in it; the next launch's diff picks it up.
 * Logs to home/host.log (stdout is the protocol channel; never console.log here).
 */
export async function runHost(argv: readonly string[]): Promise<never> {
  void [openBridge, createEngine, registry, openTransport, fileReplicaStore, loadConfig, resolvePaths];
  throw new Error('not implemented');
}
