// The real Synclium Cloud server (../../../cloud/src) in process over in-memory SQLite, so drift between
// cloud-store.ts and the server's contract fails `npm test`.
import { createCloud } from '../../../cloud/src/app.ts';
import { openVaults } from '../../../cloud/src/vaults.ts';
import type { Fetch } from '../../src/webdav-store.ts';

/** Any origin works in process: cloud-store.ts builds URLs from it, and `handle` reads only the path. */
export const CLOUD_TEST_ORIGIN = 'https://cloud.test';
/** What Chromium sends from an extension page or worker. The server refuses any other Origin. */
const EXTENSION_ORIGIN = `chrome-extension://${'a'.repeat(32)}`;

export type CloudServer = {
  readonly fetch: Fetch;
  /** The server loses every vault, as after losing its volume. */
  readonly wipe: () => void;
};

export function cloudServer(): CloudServer {
  const vaults = openVaults(':memory:');
  const cloud = createCloud({ vaults });
  return {
    fetch: (url, init) => {
      const headers = new Headers(init.headers);
      headers.set('Origin', EXTENSION_ORIGIN);
      return cloud.handle(new Request(url, { ...init, headers }), { ip: '127.0.0.1' });
    },
    wipe: () => void vaults.purgeIdle(Number.MAX_SAFE_INTEGER),
  };
}
