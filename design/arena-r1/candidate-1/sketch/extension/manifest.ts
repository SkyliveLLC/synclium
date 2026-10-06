// Build-time: emits the companion's manifest.json. Run by the package build, not at runtime.

import { extensionPermissions } from '../datatypes/registry.ts';

/** Public half of the signing key. Pins the extension id for both unpacked and store installs. */
export const EXTENSION_KEY = '<base64 SPKI>';
/** Derived from EXTENSION_KEY (sha256 -> first 32 hex chars -> a..p). Checked against the key in a test. */
export const EXTENSION_ID = '<32 chars a-p>';

export function manifest(version: string): chrome.runtime.ManifestV3 {
  return {
    manifest_version: 3,
    name: 'Helium Sync companion',
    version,
    key: EXTENSION_KEY,
    background: { service_worker: 'worker.js', type: 'module' },
    permissions: [...extensionPermissions],
  };
}
