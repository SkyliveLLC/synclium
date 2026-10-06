// Store over WebDAV (Nextcloud, ownCloud, a NAS, any DAV server). The second adapter behind the same port.
// Its edge over a folder: plain fetch from the worker, so it needs no gesture and nothing to re-grant after a
// restart. Its cost: the user needs a server, and without encryption (v1) that server sees every URL.
//
// The host permission is optional: setup.html calls chrome.permissions.request({ origins: [`${origin}/*`] }) from a
// click. `access()` is `needs-access` until it is granted, the same state the folder store uses for a lapsed grant.
import type { Store } from '../ports.ts';

export type WebDavConfig = { readonly url: string; readonly user: string; readonly password: string };

export function webdavStore(_config: WebDavConfig): Store {
  // access: chrome.permissions.contains for the origin, then PROPFIND Depth 0. 401/403 -> unreachable "sign-in rejected".
  // list:   PROPFIND Depth 1 per directory under `devices/`; getlastmodified or getetag -> version.
  // get:    GET; 404 -> null.
  // put:    MKCOL parents as needed, PUT. Atomic on mainstream servers; where a server is not, PUT to `.tmp-<key>` then MOVE.
  // delete: DELETE.
  throw new Error('not implemented');
}
