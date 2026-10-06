// v2 adapter. Adds "live" mode on top of file-profile; no engine change, no store change.
import type { Profile } from "../ports.ts";
import type { HeliumRegistry } from "../index.ts";

/**
 * Topology (observed in prototype p2):
 *   Helium --spawns--> native host (Node, ships with helium-sync) --unix socket--> CLI / desktop app
 *   extension --connectNative--> host
 * The engine runs in whichever process the user talks to (CLI, host for extension UI, desktop app);
 * all of them reach the browser through the same socket, so there is one adapter, not one per frontend.
 *
 * open(): socket reachable -> mode "live", channels backed by chrome.* via the extension.
 *         unreachable     -> delegate to `fallback` (file-profile).
 *
 * Bookmarks identity: chrome.bookmarks has no guid. The host joins chrome ids to guids by reading the
 * Bookmarks file (ids match); nodes not yet flushed (<~2s) are omitted from the snapshot and appear next
 * cycle. Nodes the extension creates for remote items get Chromium-minted guids, so the host records
 * guid -> ItemId aliases in LocalState and both adapters resolve through them.
 */
export function liveProfile(_opts: { socketPath: string; fallback: Profile<HeliumRegistry> }): Profile<HeliumRegistry> {
  throw new Error("not implemented");
}
