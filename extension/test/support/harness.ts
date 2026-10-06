// Scenario harness: a cloud, a shared clock, and devices built from in-memory ports. Also the crash harness,
// which kills the Nth port call of a run, and the state snapshot a crash run is compared against.
import { isDeviceId, type DeviceId, type ItemId } from '../../src/model.ts';
import { createEngine, type Engine, type JoinPreview, type Policy, type SyncReport } from '../../src/engine.ts';
import { noAsks, unbounded, type Asks, type Budget, type StoreConnection, type StoreFailure } from '../../src/ports.ts';
import { gzipJson, parseManifest, type Manifest } from '../../src/store-format.ts';
import { MemoryCloud, type Attached, type FolderMode } from './memory-store.ts';
import { deviceId, memoryLocal, memoryLogLocal, memorySink, type MemoryLocal, type MemoryLogLocal, type MemorySink } from './memory-local.ts';
import { FakeBrowser, fakeBookmarks, itemIds, type Api, type FakeChannel } from './fake-bookmarks.ts';
import { FakeHistory } from './fake-history.ts';
import { ground } from './ground.ts';

export const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);

export class FakeClock {
  now: number;
  constructor(start = T0) {
    this.now = start;
  }
  tick(ms: number): void {
    this.now += ms;
  }
  skewed(skewMs: number): { now(): number } {
    return { now: () => this.now + skewMs };
  }
}

export class CrashError extends Error {}

/**
 * The crash harness. Call `at` (1-based, counted across every wrapped port, or only calls to `method` when
 * given) throws before or after it runs. `at: Infinity` only counts.
 */
export class Crasher {
  calls = 0;
  at: number;
  when: 'before' | 'after';
  method: string | null;
  fired = false;
  constructor(at: number = Infinity, when: 'before' | 'after' = 'before', method: string | null = null) {
    this.at = at;
    this.when = when;
    this.method = method;
  }

  /** Re-arm for the next calls: kill at call `at` (of `method`, or of any port) from now. */
  arm(at: number, when: 'before' | 'after', method: string | null = null): void {
    this.at = at;
    this.when = when;
    this.method = method;
    this.calls = 0;
    this.fired = false;
  }

  wrap<T extends object>(port: T): T {
    const self = this;
    return new Proxy(port, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') return value;
        return async (...args: unknown[]) => {
          const k = self.method === null || self.method === prop ? ++self.calls : 0;
          if (k === self.at && self.when === 'before') {
            self.fired = true;
            throw new CrashError(`killed before call ${k} (${String(prop)})`);
          }
          const result: unknown = await Reflect.apply(value, target, args);
          if (k === self.at && self.when === 'after') {
            self.fired = true;
            throw new CrashError(`killed after call ${k} (${String(prop)})`);
          }
          return result;
        };
      },
    });
  }
}

export type DeviceOptions = {
  readonly browser?: FakeBrowser;
  readonly skewMs?: number;
  readonly live?: boolean;
  readonly policy?: Partial<Policy>;
  readonly crasher?: Crasher;
};

export class Device {
  readonly name: string;
  readonly attached: Attached;
  readonly browser: FakeBrowser;
  readonly channel: FakeChannel;
  readonly history: FakeHistory;
  readonly sink: MemorySink;
  readonly logLocal: MemoryLogLocal;
  readonly local: MemoryLocal;
  readonly engine: Engine;
  /** What `connect` answers. Tests flip it to simulate a lapsed grant. */
  access: 'ready' | StoreFailure = 'ready';
  readonly ids: (hint: string) => ItemId;

  constructor(name: string, index: number, cloud: MemoryCloud, clock: FakeClock, opts: DeviceOptions) {
    this.name = name;
    this.attached = cloud.attach(name, opts.live ?? false);
    this.browser = opts.browser ?? new FakeBrowser();
    this.ids = itemIds(name.toLowerCase());
    const wrap = <T extends object>(port: T): T => (opts.crasher === undefined ? port : opts.crasher.wrap(port));
    const api: Api = wrap({ call: async () => {} });
    this.channel = fakeBookmarks(this.browser, this.ids, api);
    this.history = new FakeHistory();
    this.sink = memorySink();
    this.logLocal = memoryLogLocal();
    const deviceClock = clock.skewed(opts.skewMs ?? 0);
    let minted = 0;
    this.local = memoryLocal(deviceClock, () => deviceId(index * 100 + ++minted));
    const store = wrap(this.attached.store);
    this.engine = createEngine({
      connect: async (): Promise<StoreConnection> =>
        this.access === 'ready' ? { access: 'ready', label: 'memory', store } : { access: 'failed', label: 'memory', why: this.access },
      local: wrap(this.local),
      bookmarks: wrap(this.channel),
      history: { source: wrap(this.history), sink: wrap(this.sink), local: wrap(this.logLocal) },
      codec: gzipJson,
      clock: deviceClock,
      platform: 'mac',
      appVersion: '0.0.0-test',
      ...(opts.policy === undefined ? {} : { policy: opts.policy }),
    });
  }

  async setup(historyOn = true): Promise<void> {
    await this.local.reset({ name: this.name, historyOn });
  }

  get device(): DeviceId {
    const state = this.local.state();
    if (state === null) throw new Error(`${this.name} is not set up`);
    return state.device;
  }

  /** One `sync` call. Crashes propagate. */
  sync(budget: Budget = unbounded, asks: Asks = noAsks): Promise<SyncReport> {
    return this.engine.sync({ budget, asks });
  }

  preview(): Promise<JoinPreview> {
    return this.engine.sync({ preview: true });
  }

  /** Sync until the report says complete, rerunning after a crash the way the scheduler's resume alarm would. */
  async syncUntilComplete(budgets: () => Budget = () => unbounded, asks: Asks = noAsks): Promise<SyncReport> {
    for (let i = 0; i < 500; i++) {
      let report: SyncReport;
      try {
        report = await this.engine.sync({ budget: budgets(), asks });
      } catch (error) {
        if (error instanceof CrashError) continue;
        throw error;
      }
      if (report.kind !== 'cycle' || report.complete) return report;
    }
    throw new Error(`${this.name} never completed`);
  }

  pull(): void {
    this.attached.pull();
  }
  push(): void {
    this.attached.push();
  }

  /** P3's `cycle`: pull, sync to completion, push. */
  async cycle(budgets?: () => Budget, asks?: Asks): Promise<SyncReport> {
    this.pull();
    const report = await this.syncUntilComplete(budgets, asks);
    this.push();
    return report;
  }
}

export class World {
  readonly cloud: MemoryCloud;
  readonly clock: FakeClock;
  readonly devices = new Map<string, Device>();
  #index = 0;

  constructor(mode: FolderMode = 'icloud', clock = new FakeClock()) {
    this.cloud = new MemoryCloud(mode);
    this.clock = clock;
  }

  add(name: string, opts: DeviceOptions = {}): Device {
    const device = new Device(name, ++this.#index, this.cloud, this.clock, opts);
    this.devices.set(name, device);
    return device;
  }

  dev(name: string): Device {
    const device = this.devices.get(name);
    if (device === undefined) throw new Error(`no device ${name}`);
    return device;
  }

  /** Every device cycles once, in order, a second apart. */
  async round(): Promise<void> {
    for (const device of this.devices.values()) {
      this.clock.tick(1000);
      await device.cycle();
    }
  }

  /** Rounds until every device renders the same tree, then one more round that must change nothing. */
  async converge(rounds = 4): Promise<string> {
    for (let i = 0; i < rounds; i++) await this.round();
    const renders = [...this.devices.values()].map((d) => d.browser.render());
    await this.round();
    const again = [...this.devices.values()].map((d) => d.browser.render());
    const first = renders[0] ?? '';
    for (const [i, render] of renders.entries()) {
      if (render !== first) throw new Error(`device ${i} differs from device 0:\n${first}\n---\n${render}`);
      if (again[i] !== render) throw new Error(`device ${i} changed on an idle round`);
    }
    return first;
  }

  noFolderConflicts(): void {
    if (this.cloud.conflicts !== 0 || this.cloud.silentLosses !== 0)
      throw new Error(`folder saw ${this.cloud.conflicts} conflicts and ${this.cloud.silentLosses} silent losses`);
  }
}

/** X and Y start from the same profile and are in sync before a scenario edits anything. */
export async function syncedPair(world: World, opts: { readonly x?: DeviceOptions; readonly y?: DeviceOptions } = {}): Promise<{ x: Device; y: Device }> {
  const x = world.add('X', { browser: ground(), ...opts.x });
  const y = world.add('Y', { browser: ground(), ...opts.y });
  await x.setup();
  await y.setup();
  await x.cycle();
  await y.cycle();
  await x.cycle();
  if (x.browser.render() !== y.browser.render()) throw new Error('pair did not start in sync');
  return { x, y };
}

// ---------- Snapshots a crash or budget run is compared against ----------

type Snapshot = { readonly [k: string]: unknown };

/** Decoded cloud content with the fields that legitimately differ between runs (seq, stamps of writing, hashes) removed. */
async function cloudSnapshot(cloud: MemoryCloud): Promise<Snapshot> {
  const out: { [k: string]: unknown } = {};
  for (const [path, file] of [...cloud.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (path.endsWith('manifest.json')) {
      const device = path.split('/')[1] ?? '';
      const manifest: Manifest | null = isDeviceId(device) ? parseManifest(file.data, device) : null;
      out[path] = manifest === null ? 'unparseable' : { name: manifest.name, files: [...manifest.files.keys()].sort() };
      continue;
    }
    const newline = file.data.indexOf(0x0a);
    const decoded = await gzipJson.decode(file.data.subarray(newline + 1));
    if (!decoded.ok) {
      out[path] = `undecodable: ${decoded.detail}`;
      continue;
    }
    const body = decoded.body;
    if (typeof body === 'object' && body !== null && 'seq' in body && 'writtenAt' in body) {
      const { seq: _seq, writtenAt: _writtenAt, ...rest } = body;
      out[path] = rest;
    } else out[path] = body;
  }
  return out;
}

export async function worldSnapshot(world: World): Promise<string> {
  const devices: { [name: string]: unknown } = {};
  for (const [name, d] of world.devices) {
    devices[name] = {
      tree: d.browser.render(),
      ownDays: [...d.logLocal.days()].map(([day, visits]) => [day, visits.map((v) => [v.url, v.t])]),
      indexed: [...d.sink.indexed()].map(([device, days]) => [device, [...days].map(([day, visits]) => [day, visits.map((v) => [v.url, v.t])])]),
      cursor: d.local.state()?.history,
    };
  }
  return JSON.stringify({ cloud: await cloudSnapshot(world.cloud), devices }, null, 1);
}

/** A budget that expires after `units` checks, for the "expire after every unit" sweep. */
export function expireAfter(units: number): Budget {
  let checks = 0;
  return { expired: () => ++checks > units };
}
