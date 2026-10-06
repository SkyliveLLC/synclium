// A dumb sync folder in memory, after P3's Cloud/Replica model. Each attached device has its own replica of the
// folder; `push` uploads dirty files and `pull` downloads the rest, so a scenario can hold a device offline.
// A `live` attachment pushes and pulls around every call, which is a store every device sees at once.
//
// The folder modes decide what happens when a push finds the cloud copy moved since the download:
//   dropbox  a "conflicted copy" file appears beside the original
//   icloud   the upload wins and the other write is lost
// One writer per key means neither ever triggers; the tests assert that.
import { StoreError, type Fetched, type ProbeResult, type Store } from '../../src/ports.ts';

export type FolderMode = 'dropbox' | 'icloud';

type CloudFile = { readonly data: Uint8Array; readonly rev: number };
type LocalFile = { data: Uint8Array | null; rev: number; ver: number; dirty: boolean };

export type Knobs = {
  /** Every call rejects with StoreError unreachable. */
  unreachable: boolean;
  /** The next n pushes upload the first half of every dirty `.hsync` body and leave it dirty, as a sync client mid-transfer. */
  tearNextPushes: number;
  /** `get` with a known version answers unchanged whatever happened, like a stale lastModified. */
  forceUnchanged: boolean;
};

export class MemoryCloud {
  readonly files = new Map<string, CloudFile>();
  conflicts = 0;
  silentLosses = 0;
  readonly mode: FolderMode;

  constructor(mode: FolderMode) {
    this.mode = mode;
  }

  attach(label: string, live = false): Attached {
    return new Attached(this, label, live);
  }

  snapshot(): ReadonlyMap<string, CloudFile> {
    return new Map(this.files);
  }

  /** The cloud forgets everything after `snapshot`, as a sync service rolling back does. */
  restore(snapshot: ReadonlyMap<string, CloudFile>): void {
    this.files.clear();
    for (const [k, v] of snapshot) this.files.set(k, v);
  }
}

export class Attached {
  readonly store: Store;
  readonly knobs: Knobs = { unreachable: false, tearNextPushes: 0, forceUnchanged: false };
  readonly local = new Map<string, LocalFile>();
  readonly #cloud: MemoryCloud;
  readonly #label: string;
  readonly #live: boolean;

  constructor(cloud: MemoryCloud, label: string, live: boolean) {
    this.#cloud = cloud;
    this.#label = label;
    this.#live = live;
    this.store = this.#store();
  }

  push(): void {
    const torn = this.knobs.tearNextPushes > 0;
    if (torn) this.knobs.tearNextPushes--;
    for (const [path, f] of this.local) {
      if (!f.dirty) continue;
      const c = this.#cloud.files.get(path);
      if (c === undefined || c.rev === f.rev) {
        const tear = torn && f.data !== null && path.endsWith('.hsync');
        if (f.data === null) this.#cloud.files.delete(path);
        else this.#cloud.files.set(path, { data: tear ? f.data.subarray(0, Math.floor(f.data.length / 2)) : f.data, rev: (c?.rev ?? 0) + 1 });
        f.rev = (c?.rev ?? 0) + 1;
        if (tear) continue;
      } else if (this.#cloud.mode === 'dropbox') {
        this.#cloud.conflicts++;
        if (f.data !== null) this.#cloud.files.set(`${path} (${this.#label} conflicted copy)`, { data: f.data, rev: 1 });
        f.rev = -1;
      } else {
        this.#cloud.silentLosses++;
        if (f.data === null) this.#cloud.files.delete(path);
        else this.#cloud.files.set(path, { data: f.data, rev: c.rev + 1 });
        f.rev = c.rev + 1;
      }
      f.dirty = false;
    }
  }

  pull(): void {
    for (const [path, c] of this.#cloud.files) {
      const f = this.local.get(path);
      if (f !== undefined && f.dirty) continue;
      if (f === undefined) this.local.set(path, { data: c.data, rev: c.rev, ver: 1, dirty: false });
      else if (f.rev !== c.rev || f.data !== c.data) {
        f.data = c.data;
        f.rev = c.rev;
        f.ver++;
      }
    }
    for (const [path, f] of this.local) if (!f.dirty && !this.#cloud.files.has(path)) this.local.delete(path);
  }

  #store(): Store {
    const guard = () => {
      if (this.knobs.unreachable) throw new StoreError({ kind: 'unreachable', detail: 'memory store offline' });
    };
    const before = () => {
      guard();
      if (this.#live) this.pull();
    };
    const after = () => {
      if (this.#live) this.push();
    };
    return {
      list: async (prefix) => {
        before();
        const names = new Set<string>();
        for (const [path, f] of this.local) {
          if (f.data === null || !path.startsWith(prefix)) continue;
          const rest = path.slice(prefix.length);
          const slash = rest.indexOf('/');
          names.add(slash < 0 ? rest : rest.slice(0, slash));
        }
        return [...names].sort();
      },
      get: async (key, known): Promise<Fetched> => {
        before();
        const f = this.local.get(key);
        if (f === undefined || f.data === null) return { kind: 'missing' };
        if (known !== null && (this.knobs.forceUnchanged || known === String(f.ver))) return { kind: 'unchanged' };
        return { kind: 'ok', bytes: f.data, version: String(f.ver) };
      },
      put: async (key, bytes) => {
        before();
        const f = this.local.get(key);
        if (f === undefined) this.local.set(key, { data: bytes, rev: 0, ver: 1, dirty: true });
        else {
          f.data = bytes;
          f.ver++;
          f.dirty = true;
        }
        after();
      },
      delete: async (key) => {
        before();
        const f = this.local.get(key);
        if (f !== undefined && f.data !== null) {
          f.data = null;
          f.ver++;
          f.dirty = true;
        }
        after();
      },
      probe: async (): Promise<ProbeResult> => {
        guard();
        return { kind: 'ok' };
      },
    };
  }
}

