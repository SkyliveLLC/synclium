// An in-memory File System Access volume shaped like folder-store.ts's `Dir` port, behaving as Chromium did in P7:
// every call throws NotAllowedError once the grant reads `prompt`, a handle whose folder was removed throws
// NotFoundError, createWritable stages a `<name>.crswap` sibling that close() swaps in, and close() stamps
// lastModified from the volume clock.
import type { FileHandle } from '../../src/folder-store.ts';

const fail = (name: string): DOMException => new DOMException(`fake ${name}`, name);

/** State every handle on one volume shares: the grant, the clock, and the knobs tests flip. */
export class FakeVolume {
  permission: PermissionState = 'granted';
  /** What requestPermission answers: the user's click on Allow or Don't Allow. */
  answer: PermissionState = 'granted';
  now = 1_000;
  /** The next writable's write() rejects with this DOMException name. */
  failNextWrite: string | null = null;
  /** Byte reads, as distinct from metadata reads. */
  reads = 0;
  readonly root: FakeDir;

  constructor(name = 'iCloud Drive') {
    this.root = new FakeDir(this, name, null);
  }

  /** P7 saw a same-size rewrite move lastModified by 2 s. */
  tick(): number {
    return (this.now += 2_000);
  }

  allowed(): void {
    if (this.permission !== 'granted') throw fail('NotAllowedError');
  }

  /** The entry at a slash path below the volume root, for assertions and for planting files. */
  at(path: string): FakeDir | FakeFile | undefined {
    let node: FakeDir | FakeFile | undefined = this.root;
    for (const name of path.split('/').filter((s) => s !== '')) node = node instanceof FakeDir ? node.entries.get(name) : undefined;
    return node;
  }

  /** Another writer (a sync client) puts bytes at `path`, creating folders. `keepModified` leaves lastModified as it was. */
  write(path: string, bytes: Uint8Array<ArrayBuffer>, { keepModified = false } = {}): void {
    const names = path.split('/').filter((s) => s !== '');
    const name = names.pop() ?? '';
    let dir = this.root;
    for (const segment of names) {
      const next = dir.entries.get(segment);
      if (next instanceof FakeFile) throw new Error(`${segment} is a file`);
      dir = next ?? dir.adopt(new FakeDir(this, segment, dir));
    }
    const existing = dir.entries.get(name);
    if (existing instanceof FakeFile) {
      existing.bytes = bytes;
      if (!keepModified) existing.lastModified = this.tick();
    } else dir.adopt(new FakeFile(this, name, dir, bytes));
  }

  text(path: string): string | undefined {
    const node = this.at(path);
    return node instanceof FakeFile ? new TextDecoder().decode(node.bytes) : undefined;
  }
}

abstract class Entry {
  readonly name: string;
  protected readonly volume: FakeVolume;
  readonly #parent: FakeDir | null;

  constructor(volume: FakeVolume, name: string, parent: FakeDir | null) {
    this.volume = volume;
    this.name = name;
    this.#parent = parent;
  }

  /** Permission first, then existence, as Chromium checks them. */
  protected live(): void {
    this.volume.allowed();
    if (!this.attached()) throw fail('NotFoundError');
  }

  attached(): boolean {
    const self: Entry = this;
    return this.#parent === null || (this.#parent.attached() && this.#parent.entries.get(this.name) === self);
  }
}

export class FakeFile extends Entry implements FileHandle {
  bytes: Uint8Array<ArrayBuffer>;
  lastModified: number;
  readonly #dir: FakeDir;

  constructor(volume: FakeVolume, name: string, dir: FakeDir, bytes: Uint8Array<ArrayBuffer>) {
    super(volume, name, dir);
    this.#dir = dir;
    this.bytes = bytes;
    this.lastModified = volume.tick();
  }

  async getFile() {
    this.live();
    const { bytes, lastModified, volume } = this;
    return {
      lastModified,
      size: bytes.length,
      arrayBuffer: async () => {
        volume.reads++;
        return bytes.slice().buffer;
      },
    };
  }

  async createWritable() {
    this.live();
    const swap = this.#dir.adopt(new FakeFile(this.volume, `${this.name}.crswap`, this.#dir, new Uint8Array(0)));
    const drop = () => void this.#dir.entries.delete(swap.name);
    return {
      write: async (data: Uint8Array<ArrayBuffer>) => {
        this.volume.allowed();
        const failure = this.volume.failNextWrite;
        this.volume.failNextWrite = null;
        if (failure !== null) throw fail(failure);
        swap.bytes = data.slice();
      },
      close: async () => {
        this.live();
        this.bytes = swap.bytes;
        this.lastModified = this.volume.tick();
        drop();
      },
      abort: async () => drop(),
    };
  }
}

/** Satisfies `Dir` structurally; `implements` would demand `Promise<this>` from getDirectoryHandle. */
export class FakeDir extends Entry {
  readonly entries = new Map<string, FakeDir | FakeFile>();

  adopt<E extends FakeDir | FakeFile>(entry: E): E {
    this.entries.set(entry.name, entry);
    return entry;
  }

  async queryPermission(): Promise<PermissionState> {
    return this.volume.permission;
  }

  async requestPermission(): Promise<PermissionState> {
    return (this.volume.permission = this.volume.answer);
  }

  async getDirectoryHandle(name: string, { create = false } = {}): Promise<FakeDir> {
    this.live();
    const found = this.entries.get(name);
    if (found instanceof FakeFile) throw fail('TypeMismatchError');
    if (found !== undefined) return found;
    if (!create) throw fail('NotFoundError');
    return this.adopt(new FakeDir(this.volume, name, this));
  }

  async getFileHandle(name: string, { create = false } = {}): Promise<FakeFile> {
    this.live();
    const found = this.entries.get(name);
    if (found instanceof FakeDir) throw fail('TypeMismatchError');
    if (found !== undefined) return found;
    if (!create) throw fail('NotFoundError');
    return this.adopt(new FakeFile(this.volume, name, this, new Uint8Array(0)));
  }

  async removeEntry(name: string): Promise<void> {
    this.live();
    const found = this.entries.get(name);
    if (found === undefined) throw fail('NotFoundError');
    if (found instanceof FakeDir && found.entries.size > 0) throw fail('InvalidModificationError');
    this.entries.delete(name);
  }

  async *keys(): AsyncGenerator<string> {
    this.live();
    yield* [...this.entries.keys()];
  }
}
