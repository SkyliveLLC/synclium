// Store over WebDAV with `fetch` from the service worker. Covers Nextcloud, ownCloud, Synology, Fastmail,
// Hetzner Storage Box, Koofr, pCloud, Apache mod_dav, nginx, Caddy, `rclone serve webdav`, dufs.
// HTTP hazards live here and nowhere else.
//
// Fetch rules:
//  - `credentials: 'omit'` and an explicit `Authorization: Basic` header. Never the cookie jar: a Nextcloud
//    session cookie would turn on its CSRF check and 401 us.
//  - The store origin is in the extension's granted host permissions, so CORS does not apply. Without the
//    grant, fetch fails with a TypeError; `hasHostPermission` runs first so the error is `no-host-permission`.
//  - `list`  PROPFIND Depth: 1 per collection, walked recursively (Depth: infinity is usually disabled).
//            No DOMParser in a service worker; a 40-line tag scanner reads href, getetag, getcontentlength,
//            resourcetype/collection. Only `list('devices/')` for discovery and `probe` use it.
//  - `get`   GET with If-None-Match: <known>; 304 -> unchanged; 404 -> missing; ETag -> version.
//  - `put`   PUT; 409 (missing parent) -> MKCOL each missing segment, then retry once.
//            No temp+MOVE: readers verify bytes against the manifest hash, so a torn PUT reads as "not yet".
//  - `delete` DELETE; 404 counts as done.
//  - `probe` OPTIONS (expects a DAV header), then MKCOL the root (405 = exists), then PROPFIND Depth: 0.
//  - Status mapping: network TypeError -> offline; 401 -> auth-rejected; 403 -> forbidden; 5xx -> server-error;
//    no DAV header -> not-a-dav-server. Everything else is a StoreError too; the engine never sees fetch.
import type { Store } from '../ports.ts';
import type { StoreConfig } from './store-config.ts';

export function webdavStore(_config: StoreConfig & { readonly kind: 'webdav' }): Store {
  throw new Error('not implemented');
}

/** One PROPFIND response row. Internal; `list` maps rows to StoreEntry names relative to the root. */
type DavRow = { readonly href: string; readonly collection: boolean; readonly etag: string | null; readonly size: number | null };

/** Tolerates `d:`, `D:`, and no prefix; ignores everything it does not recognise. */
function parseMultistatus(_xml: string): readonly DavRow[] {
  throw new Error('not implemented');
}
