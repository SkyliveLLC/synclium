// Google Drive v3 in memory, served through a `fetch` stand-in. Enough for drive-store.ts: files.list with the
// queries it sends, files.get (metadata and alt=media), folder create, multipart and media uploads, delete, and
// about. Trashing a folder hides everything under it, as Drive does. Ids are minted in creation order, so
// "oldest first" is id order.
import type { Fetch } from '../../src/webdav-store.ts';

const FOLDER = 'application/vnd.google-apps.folder';

type Node = { readonly id: string; name: string; parent: string; readonly folder: boolean; bytes: Uint8Array; trashed: boolean; rev: number };

const STRING = String.raw`'((?:\\.|[^'\\])*)'`;
const unquote = (s: string) => s.replace(/\\(.)/g, '$1');

function indexOf(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

export class FakeDrive {
  readonly account = 'me@example.com';
  readonly nodes = new Map<string, Node>();
  /** Tokens Drive accepts. A token not in here answers 401. */
  readonly valid = new Set(['t1']);
  offline = false;
  /** The next request answers this status and body, whatever it asked. */
  failNext: { readonly status: number; readonly body: string } | null = null;
  /** `METHOD path` per request, for asserting what an operation cost. */
  readonly log: string[] = [];
  #ids = 0;

  constructor() {
    this.nodes.set('root', { id: 'root', name: 'My Drive', parent: '', folder: true, bytes: new Uint8Array(), trashed: false, rev: 0 });
  }

  /** Trashed itself, or under a trashed folder. */
  hidden(node: Node): boolean {
    for (let n: Node | undefined = node; n !== undefined; n = this.nodes.get(n.parent)) if (n.trashed) return true;
    return false;
  }

  /** The visible node at `path` under `from`, e.g. 'Helium Sync/devices/'. */
  at(path: string, from = 'root'): Node | undefined {
    let node = this.nodes.get(from);
    for (const name of path.split('/').filter((s) => s !== '')) node = [...this.nodes.values()].find((n) => n.parent === node?.id && n.name === name && !this.hidden(n));
    return node;
  }

  text(path: string, from = 'root'): string | undefined {
    const node = this.at(path, from);
    return node === undefined || node.folder ? undefined : new TextDecoder().decode(node.bytes);
  }

  create(parent: string, name: string, folder: boolean, bytes = new Uint8Array()): Node {
    const node: Node = { id: `id${String(++this.#ids).padStart(4, '0')}`, name, parent, folder, bytes, trashed: false, rev: 1 };
    this.nodes.set(node.id, node);
    return node;
  }

  /** A peer's write, straight to Drive. */
  write(path: string, text: string, from = 'root'): void {
    const node = this.at(path, from);
    if (node === undefined) throw new Error(`no file at ${path}`);
    node.bytes = new TextEncoder().encode(text);
    node.rev++;
  }

  #md5(node: Node): string {
    return `${node.rev}:${new TextDecoder().decode(node.bytes)}`; // stands in for a content hash
  }

  #json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }

  #entry(node: Node) {
    return { id: node.id, name: node.name, ...(node.folder ? {} : { md5Checksum: this.#md5(node) }) };
  }

  #query(q: string): Node[] {
    const parent = new RegExp(`${STRING} in parents`).exec(q)?.[1];
    const name = new RegExp(`name = ${STRING}`).exec(q)?.[1];
    const mime = new RegExp(`mimeType (=|!=) ${STRING}`).exec(q);
    return [...this.nodes.values()].filter(
      (n) =>
        n.id !== 'root' &&
        !this.hidden(n) &&
        (parent === undefined || n.parent === unquote(parent)) &&
        (name === undefined || n.name === unquote(name)) &&
        (mime === null || (mime[1] === '=') === (n.folder === (unquote(mime[2] ?? '') === FOLDER))),
    );
  }

  readonly fetch: Fetch = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    const method = init.method ?? 'GET';
    this.log.push(`${method} ${pathname}`);
    if (this.offline) throw new TypeError('Failed to fetch');
    if (this.failNext !== null) {
      const { status, body } = this.failNext;
      this.failNext = null;
      return new Response(body, { status });
    }
    const headers = new Headers(init.headers);
    if (!this.valid.has(headers.get('Authorization')?.replace(/^Bearer /, '') ?? '')) return this.#json(401, { error: { code: 401 } });

    if (pathname === '/drive/v3/about') return this.#json(200, { user: { emailAddress: this.account } });
    if (pathname === '/drive/v3/files' && method === 'GET') {
      const found = this.#query(searchParams.get('q') ?? '');
      return this.#json(200, { files: found.map((n) => this.#entry(n)) });
    }
    if (pathname === '/drive/v3/files' && method === 'POST') {
      const meta: unknown = JSON.parse(String(init.body));
      if (typeof meta !== 'object' || meta === null || !('name' in meta) || !('parents' in meta) || !Array.isArray(meta.parents)) return this.#json(400, {});
      return this.#json(200, this.#entry(this.create(String(meta.parents[0]), String(meta.name), true)));
    }
    if (pathname === '/upload/drive/v3/files' && method === 'POST') {
      const boundary = /boundary=(.+)$/.exec(headers.get('Content-Type') ?? '')?.[1] ?? '';
      const body = new Uint8Array(await new Response(init.body).arrayBuffer());
      const enc = new TextEncoder();
      const metaStart = indexOf(body, enc.encode('\r\n\r\n')) + 4;
      const metaEnd = indexOf(body, enc.encode(`\r\n--${boundary}`), metaStart);
      const meta: unknown = JSON.parse(new TextDecoder().decode(body.slice(metaStart, metaEnd)));
      const dataStart = indexOf(body, enc.encode('\r\n\r\n'), metaEnd) + 4;
      const dataEnd = indexOf(body, enc.encode(`\r\n--${boundary}--`), dataStart);
      if (typeof meta !== 'object' || meta === null || !('name' in meta) || !('parents' in meta) || !Array.isArray(meta.parents)) return this.#json(400, {});
      return this.#json(200, this.#entry(this.create(String(meta.parents[0]), String(meta.name), false, body.slice(dataStart, dataEnd))));
    }

    const id = decodeURIComponent(pathname.split('/').at(-1) ?? '');
    const node = this.nodes.get(id);
    if (node === undefined) return this.#json(404, { error: { code: 404 } });
    if (pathname.startsWith('/upload/') && method === 'PATCH') {
      node.bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
      node.rev++;
      return this.#json(200, this.#entry(node));
    }
    if (method === 'DELETE') {
      const doomed = [node.id];
      for (let i = 0; i < doomed.length; i++) for (const n of this.nodes.values()) if (n.parent === doomed[i]) doomed.push(n.id);
      for (const d of doomed) this.nodes.delete(d);
      return new Response(null, { status: 204 });
    }
    if (searchParams.get('alt') === 'media') return new Response(node.bytes.slice(), { status: 200 });
    return this.#json(200, { trashed: node.trashed });
  };
}
