// Which store a device syncs through: Synclium Cloud (cloud-store.ts), the folder it picked (folder-store.ts),
// a WebDAV server (webdav-store.ts), or Google Drive (drive-store.ts), as saved in local.ts's store slots. The
// engine sees only the Store port; this module is the one switch over the choice, so a new kind fails to compile
// here until it is handled.
//
// Connecting takes the sync group's key. Synclium Cloud finds its vault by it; a store addressed by its choice
// (folder, server, Drive) ignores it. The key goes no further than this switch: the cloud gets only the token.
import type { ProbeResult, StoreConnection, StoreStatus } from './ports.ts';
import { vaultTokenFor, type SyncKey } from './sync-key.ts';
import { allowCloud, connectCloud } from './cloud-store.ts';
import { allowRoot, connectRoot } from './folder-store.ts';
import { allowWebdav, connectWebdav } from './webdav-store.ts';
import { allowDrive, connectDrive } from './drive-store.ts';
import { slots, type StoreChoice } from './local.ts';
import type { StoreBackend } from './background.ts';

/** What setup's choose step returns, for Synclium Cloud, a folder, a server, or Google Drive alike. */
export type Chosen =
  /** The user closed the picker or declined the permission prompt. */
  | { readonly kind: 'cancelled' }
  /** Saved as `candidate` only when the probe passed, so a store that cannot be used never reaches Start. */
  | { readonly kind: 'chosen'; readonly label: string; readonly probe: ProbeResult };

/** Never prompts. */
export async function connectChoice(choice: StoreChoice | undefined, key: SyncKey): Promise<StoreConnection> {
  switch (choice?.kind) {
    case undefined:
      return { access: 'not-set-up' };
    case 'cloud':
      return connectCloud(await vaultTokenFor(key));
    case 'folder':
      return connectRoot(choice.handle);
    case 'webdav':
      return connectWebdav(choice.config);
    case 'drive':
      return connectDrive(choice.config);
    default: {
      const unreachable: never = choice;
      return unreachable;
    }
  }
}

/** What the release worker runs on. */
export const releaseBackend: StoreBackend = {
  connect: async (slot, key) => connectChoice(await slots.get(slot), key),
  promote: slots.promote,
};

/**
 * App page, inside a click, for app.html#allow: the folder's re-grant prompt, the server's host permission, or
 * Google's sign-in window. Synclium Cloud has nothing to allow.
 * The page reads `choice` before the click, so the prompt is the first thing the click awaits.
 */
export function allowStore(choice: StoreChoice | undefined): Promise<StoreStatus> {
  switch (choice?.kind) {
    case undefined:
      return Promise.resolve({ access: 'not-set-up' });
    case 'cloud':
      return allowCloud();
    case 'folder':
      return allowRoot(choice.handle);
    case 'webdav':
      return allowWebdav(choice.config);
    case 'drive':
      return allowDrive(choice.config);
    default: {
      const unreachable: never = choice;
      return unreachable;
    }
  }
}
