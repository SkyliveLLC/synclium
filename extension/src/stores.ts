// Which store a device syncs through: the folder it picked (folder-store.ts) or a WebDAV server
// (webdav-store.ts), as saved in local.ts's store slots. The engine sees only the Store port; this module is the
// one switch over the choice, so a third kind fails to compile here until it is handled.
import type { ProbeResult, StoreConnection, StoreStatus } from './ports.ts';
import { allowRoot, connectRoot } from './folder-store.ts';
import { allowWebdav, connectWebdav } from './webdav-store.ts';
import { slots, type StoreChoice } from './local.ts';
import type { StoreBackend } from './background.ts';

/** What setup's choose step returns, for a folder or a server alike. */
export type Chosen =
  /** The user closed the picker or declined the permission prompt. */
  | { readonly kind: 'cancelled' }
  /** Saved as `candidate` only when the probe passed, so a store that cannot be written never reaches Start. */
  | { readonly kind: 'chosen'; readonly label: string; readonly probe: ProbeResult };

/** Never prompts. */
export async function connectChoice(choice: StoreChoice | undefined): Promise<StoreConnection> {
  switch (choice?.kind) {
    case undefined:
      return { access: 'not-set-up' };
    case 'folder':
      return connectRoot(choice.handle);
    case 'webdav':
      return connectWebdav(choice.config);
    default: {
      const unreachable: never = choice;
      return unreachable;
    }
  }
}

/** What the release worker runs on. */
export const releaseBackend: StoreBackend = {
  connect: async (slot) => connectChoice(await slots.get(slot)),
  promote: slots.promote,
};

/**
 * App page, inside a click, for app.html#allow: the folder's re-grant prompt or the server's host permission.
 * The page reads `choice` before the click, so the prompt is the first thing the click awaits.
 */
export function allowStore(choice: StoreChoice | undefined): Promise<StoreStatus> {
  switch (choice?.kind) {
    case undefined:
      return Promise.resolve({ access: 'not-set-up' });
    case 'folder':
      return allowRoot(choice.handle);
    case 'webdav':
      return allowWebdav(choice.config);
    default: {
      const unreachable: never = choice;
      return unreachable;
    }
  }
}
