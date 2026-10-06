// The documented fallback store, not wired in v1. Adopted as the default if P7 lands on rung C (and Conan
// rejects the click per browser start) or on rung E. It needs no gesture and nothing to re-grant after a
// restart. Its cost: the user needs a WebDAV account, and with no encryption in v1 that server sees every URL.
// Nothing above the Store port changes; background.ts swaps `connectFolder` for `connectWebdav`.
import type { Store, StoreConnection } from './ports.ts';

export type WebdavConfig = { readonly url: string; readonly user: string; readonly password: string };

/**
 * chrome.permissions.contains({ origins: [origin] }) false -> failed needs-permission (the same popup state a
 * lapsed folder grant shows). Otherwise ready with webdavStore(config).
 */
export async function connectWebdav(_config: WebdavConfig): Promise<StoreConnection> {
  throw new Error('not implemented');
}

/**
 * Fetch from the worker with `credentials: 'omit'` and an explicit Basic header (candidate 2's rules).
 *  - get:    GET with If-None-Match: <known>; 304 -> unchanged; 404 -> missing; ETag -> version.
 *  - put:    PUT; 409 -> MKCOL the missing parents, retry once. No temp + MOVE: the manifest hash covers a torn PUT.
 *  - list:   PROPFIND Depth: 1. No DOMParser in a worker; a small tag scanner reads href and resourcetype.
 *  - delete: DELETE; 404 is success.
 *  - probe:  OPTIONS (expects a DAV header), MKCOL the root (405 = exists), PUT and DELETE a scratch file.
 * TypeError -> unreachable; 401, 403 -> rejected; a revoked origin -> needs-permission.
 */
export function webdavStore(_config: WebdavConfig): Store {
  throw new Error('not implemented');
}
