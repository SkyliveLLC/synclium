// A WebDAV server in memory, served through a `fetch` stand-in. Enough of RFC 4918 for webdav-store.ts:
// PROPFIND Depth 0 and 1, GET with If-None-Match, PUT (409 under a missing collection), MKCOL (405 when the
// name exists), and recursive DELETE. Paths are kept decoded; hrefs go out percent-encoded, as servers send them.
import type { Fetch } from '../../src/webdav-store.ts';

type File = { readonly bytes: Uint8Array; readonly etag: string };

export class FakeDav {
  /** The account root a user would type, e.g. a Nextcloud files URL. */
  readonly home = 'https://dav.test/files/me/';
  readonly files = new Map<string, File>();
  readonly dirs = new Set<string>(['/', '/files/', '/files/me/']);
  username = 'me';
  password = 'secret';
  /** Every request rejects as fetch does when the network is down. */
  offline = false;
  /** Some servers send no ETag; the store then versions by content hash. */
  etags = true;
  /** Prepended to every href, as a reverse proxy that mounts the server under another path would. */
  hrefPrefix = '';
  /** The next request answers this status, whatever it asked. */
  failNext: number | null = null;
  /** `METHOD /decoded/path` per request, for asserting what an operation cost. */
  readonly log: string[] = [];
  #rev = 0;

  /** The file at `path` relative to `home`, as text, or undefined. */
  text(path: string): string | undefined {
    const file = this.files.get(new URL(this.home).pathname + path);
    return file === undefined ? undefined : new TextDecoder().decode(file.bytes);
  }

  /** A peer's write, straight to the server. Makes the folders above it. */
  write(path: string, text: string): void {
    const full = new URL(this.home).pathname + path;
    for (let i = full.indexOf('/', 1); i > 0; i = full.indexOf('/', i + 1)) this.dirs.add(full.slice(0, i + 1));
    this.files.set(full, { bytes: new TextEncoder().encode(text), etag: `"${++this.#rev}"` });
  }

  hasDir(path: string): boolean {
    return this.dirs.has(new URL(this.home).pathname + path);
  }

  removeDir(path: string): void {
    this.#remove(new URL(this.home).pathname + path);
  }

  readonly fetch: Fetch = async (url, init) => {
    if (this.offline) throw new TypeError('Failed to fetch');
    const method = init.method ?? 'GET';
    const path = decodeURIComponent(new URL(url).pathname);
    this.log.push(`${method} ${path}`);
    const headers = new Headers(init.headers);
    if (headers.get('Authorization') !== `Basic ${btoa(`${this.username}:${this.password}`)}`) return status(401);
    if (this.failNext !== null) {
      const code = this.failNext;
      this.failNext = null;
      return status(code);
    }
    const dir = path.endsWith('/') ? path : `${path}/`;
    const parent = dir.slice(0, -1).replace(/[^/]*$/, '');
    switch (method) {
      case 'PROPFIND': {
        const rows = this.dirs.has(dir) ? [dir, ...(headers.get('Depth') === '0' ? [] : this.#children(dir))] : this.files.has(path) ? [path] : null;
        return rows === null ? status(404) : multistatus(rows.map((row) => this.hrefPrefix + row));
      }
      case 'GET': {
        const file = this.files.get(path);
        if (file === undefined) return status(this.dirs.has(dir) ? 405 : 404);
        if (this.etags && headers.get('If-None-Match') === file.etag) return status(304);
        return new Response(file.bytes.slice(), { status: 200, headers: this.etags ? { ETag: file.etag } : {} });
      }
      case 'PUT': {
        if (!this.dirs.has(parent)) return status(409);
        const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
        this.files.set(path, { bytes, etag: `"${++this.#rev}"` });
        return status(201);
      }
      case 'MKCOL': {
        if (this.dirs.has(dir) || this.files.has(path)) return status(405);
        if (!this.dirs.has(parent)) return status(409);
        this.dirs.add(dir);
        return status(201);
      }
      case 'DELETE': {
        if (this.files.delete(path)) return status(204);
        if (!this.dirs.has(dir)) return status(404);
        this.#remove(dir);
        return status(204);
      }
      default:
        return status(405);
    }
  };

  #children(dir: string): readonly string[] {
    const direct = (p: string) => p !== dir && p.startsWith(dir) && !p.slice(dir.length, -1).includes('/');
    return [...[...this.dirs].filter(direct), ...[...this.files.keys()].filter((p) => p.startsWith(dir) && !p.slice(dir.length).includes('/'))];
  }

  #remove(dir: string): void {
    for (const d of this.dirs) if (d.startsWith(dir)) this.dirs.delete(d);
    for (const f of this.files.keys()) if (f.startsWith(dir)) this.files.delete(f);
  }
}

const status = (code: number) => new Response(null, { status: code });

const href = (path: string) => path.split('/').map(encodeURIComponent).join('/');

function multistatus(paths: readonly string[]): Response {
  const rows = paths.map((p) => `<D:response><D:href>${href(p)}</D:href><D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`);
  return new Response(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${rows.join('')}</D:multistatus>`, { status: 207 });
}
