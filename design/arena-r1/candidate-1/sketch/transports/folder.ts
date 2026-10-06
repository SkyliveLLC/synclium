// Transports: TransportConfig is the only transport shape a frontend ever sees (it is what `setup` stores).
// Each kind maps to one Transport implementation. Adding S3/WebDAV/hosted = one union member + one case.

import fs from 'node:fs/promises';
import type { Transport } from '../engine/engine.ts';
import type { Brand } from '../engine/model.ts';

/** Absolute, existing directory. Minted by `parseFolder` at the CLI boundary. */
export type FolderPath = Brand<string, 'FolderPath'>;

export type TransportConfig = { readonly kind: 'folder'; readonly path: FolderPath };
// later: | { kind: 's3'; bucket; prefix; credentialsRef } | { kind: 'webdav'; url; credentialsRef } | { kind: 'hosted'; url; token }

/** No default branch: a new TransportConfig kind without a case fails to compile (missing return). */
export function openTransport(config: TransportConfig): Transport {
  switch (config.kind) {
    case 'folder':
      return folderTransport(config.path);
  }
}

/** Resolve, require an existing directory, refuse paths inside Helium's user-data dir. */
export async function parseFolder(input: string): Promise<FolderPath> {
  throw new Error('not implemented');
}

/**
 * Layout: `<root>/helium-sync/devices/<DeviceId>.hsync`. Nothing else is shared, so there is no file two
 * devices both write. Everything not matching that name is ignored: Dropbox "(conflicted copy)" files,
 * our `.tmp-*` write files, iCloud `.<name>.icloud` placeholders (TODO: ask the OS to materialize them).
 * writeOwn = write `.tmp-<rand>` in the same dir, fsync, rename over the target.
 * watch = fs.watch on the devices dir; unreliable on cloud folders, so the host also polls.
 */
function folderTransport(root: FolderPath): Transport {
  throw new Error('not implemented');
}
