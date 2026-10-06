// Installing and removing the browser side. Every step is converge-style: compare, write only if different,
// so re-running `setup` repairs a half-finished install or a moved Node binary.

import type { Paths } from '../host/local.ts';

/**
 * 1. home/host: `#!/bin/sh\nexec "<process.execPath>" "<package>/dist/host/main.js" "$@"` (chmod 755)
 * 2. <helium>/NativeMessagingHosts/dev.helium_sync.host.json:
 *      { name, description, path: home/host, type: 'stdio', allowed_origins: [`chrome-extension://${EXTENSION_ID}/`] }
 *    The one file we write under Helium's dir: Chromium's documented native-host registration point.
 *    Windows registers hosts in the registry instead (key path for Helium unverified).
 * 3. home/extension/: copy the built companion (unpacked install path; harmless once a store build exists).
 */
export async function installHost(paths: Paths): Promise<{ readonly changed: boolean }> {
  throw new Error('not implemented');
}

/** Inverse of installHost. Leaves the store and Helium's bookmarks untouched. */
export async function uninstallHost(paths: Paths): Promise<void> {
  throw new Error('not implemented');
}

/** How the user gets the companion into Helium. Store listing once published; unpacked until then. */
export type ExtensionDelivery =
  | { readonly kind: 'store'; readonly url: string }
  | { readonly kind: 'unpacked'; readonly dir: string };

/**
 * Prints the steps and opens the right page in Helium (`open -a Helium <url>` on macOS).
 * unpacked: chrome://extensions (opening it from outside the browser is unverified) -> Developer mode -> Load unpacked -> <dir> (dir copied to clipboard).
 */
export async function guideExtensionInstall(delivery: ExtensionDelivery): Promise<void> {
  throw new Error('not implemented');
}
