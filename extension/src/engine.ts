// The deep module. The scheduler calls `sync` once per wake; the report lands in chrome.storage.local for the
// popup. Store access, manifests, merging, stamping, adoption, GC, idle handling, rollback checks, log shards,
// snapshots, budgets, and crash ordering all live behind two methods.
//
// The engine holds nothing between calls and takes no lock (the scheduler holds the Web Lock). The runtime
// builds one per wake from IndexedDB, so "terminated mid-cycle" and "crashed mid-cycle" are the same event.
//
// Crash ordering, the invariant every phase keeps: own state is committed locally before anything is put;
// files are put before the local record of them; that record is saved before the manifest that names them;
// a file leaves the manifest before it leaves the store, and the local record forgets it only after that.
// A file put without its manifest is invisible to readers. A manifest naming bytes that never landed reads as
// "not yet". A saved record ahead of its manifest makes the next cycle re-put the manifest.
import { DAY_MS, isDeviceId, type DeviceId, type Json } from './model.ts';
import { bookmarks, type Bookmark } from './bookmarks.ts';
import { readingList, type ReadingItem } from './reading-list.ts';
import { addresses, searchEngines, settings } from './profile-mode.ts';
import { extensions, type ExtensionList } from './extensions.ts';
import { history, type Visit } from './history.ts';
import {
  StoreError,
  freshDeviceLocal,
  type Asks,
  type Budget,
  type Clock,
  type DeviceLocal,
  type LocalState,
  type LogPorts,
  type PeerLocal,
  type ProfileChannels,
  type Published,
  type RegisterChannel,
  type SnapshotSource,
  type Store,
  type StoreConnection,
  type StoreFailure,
  type StoreStatus,
} from './ports.ts';
import { DEVICES_PREFIX, FORMAT_VERSION, keys, openManifest, parseRel, seal, sealManifest, type Cipher, type Manifest, type Platform, type RelName } from './store-format.ts';
import { cipherFor, type SyncKey } from './sync-key.ts';
import { syncRegisters } from './register-cycle.ts';
import { joinCursor, syncLog } from './log-cycle.ts';
import { syncSnapshot } from './snapshot-cycle.ts';

export type EngineDeps = {
  /** The chosen store (stores.ts `connectChoice`). Called once at the start of every cycle. */
  readonly connect: () => Promise<StoreConnection>;
  readonly local: LocalState;
  readonly bookmarks: RegisterChannel<Bookmark>;
  readonly readingList: RegisterChannel<ReadingItem>;
  /** Full profile mode, read once per cycle. Null: the mode is off or the companion is unavailable this cycle. */
  readonly profile: ProfileChannels | null;
  readonly history: LogPorts<Visit>;
  readonly extensions: SnapshotSource<ExtensionList>;
  readonly clock: Clock;
  readonly platform: Platform;
  readonly appVersion: string;
  readonly policy?: Partial<Policy>;
};

export type Policy = {
  /** A peer whose manifest is older than this is idle: skipped by merge, GC, and the history index. */
  readonly idleAfterDays: number;
  /** Rewrite our manifest at least this often, so peers do not see us as idle. */
  readonly heartbeatHours: number;
  readonly massDelete: { readonly minItems: number; readonly fraction: number };
  readonly log: { readonly slackMs: number; readonly rederiveDays: number };
};
export const defaultPolicy: Policy = {
  idleAfterDays: 90,
  heartbeatHours: 24,
  massDelete: { minItems: 20, fraction: 0.5 },
  log: { slackMs: 60_000, rederiveDays: 7 },
};

export type CycleOptions = { readonly budget: Budget; readonly asks: Asks };
export type PreviewOptions = { readonly preview: true; readonly key: SyncKey };

export interface Engine {
  /** One bounded cycle. Idempotent. `complete: false` means the budget ran out and the next wake continues. */
  sync(opts: CycleOptions): Promise<SyncReport>;
  /** What joining this store with `key` as a fresh device would do. Writes nothing to the store or to sync state. */
  sync(opts: PreviewOptions): Promise<JoinPreview>;
  /** Delete this device's files (every file our manifest lists, then the manifest) and clear local state. */
  forget(): Promise<void>;
}

// ---------- Report: plain JSON in chrome.storage.local, rendered by ui.ts ----------

export type SyncReport =
  | { readonly kind: 'needs-setup'; readonly at: number }
  /** Our own manifest has a higher seq than we wrote: a copied profile runs with our DeviceId. Nothing ran. */
  | { readonly kind: 'identity-clash'; readonly at: number; readonly device: DeviceId }
  | {
      readonly kind: 'cycle';
      readonly device: DeviceId;
      readonly name: string;
      readonly at: number;
      /** false when the budget stopped a unit of work. The scheduler re-arms `resume`. */
      readonly complete: boolean;
      /** Anything but `ready` means this cycle ran local-only: stamped, committed, applied, not published. */
      readonly store: StoreStatus;
      readonly bookmarks: RegisterOutcome;
      readonly readingList: RegisterOutcome;
      readonly settings: RegisterOutcome;
      readonly searchEngines: RegisterOutcome;
      readonly addresses: RegisterOutcome;
      readonly history: LogOutcome;
      /** Live peers' extension lists. The Extensions page compares them with this device's. */
      readonly extensions: readonly PeerExtensions[];
      readonly peers: readonly Peer[];
      readonly warnings: readonly Warning[];
    };

/** History can change thousands of items in one cycle, so reports carry counts and a short sample. */
export type ChangeSummary = {
  readonly added: number;
  readonly updated: number;
  readonly removed: number;
  readonly sample: readonly string[];
};

export type RegisterOutcome =
  | { readonly kind: 'synced'; readonly stamped: number; readonly applied: ChangeSummary }
  /** Recomputed every cycle as diff(profile, target). Never queued. */
  | { readonly kind: 'pending'; readonly why: 'budget' | 'interrupted'; readonly pending: ChangeSummary }
  /** Nothing published, nothing applied for this type. */
  | { readonly kind: 'blocked'; readonly why: Blocked }
  /** Full profile mode is off here, or the profile cannot show the type: nothing read, applied, or changed. */
  | { readonly kind: 'off' };

export type Blocked =
  | { readonly kind: 'mass-delete'; readonly removed: ChangeSummary; readonly of: number }
  | { readonly kind: 'newer-type-version'; readonly peer: DeviceId; readonly version: number };

export type LogOutcome =
  | { readonly kind: 'off' }
  | {
      readonly kind: 'synced';
      readonly collected: number;
      readonly publishedDays: number;
      /** Own days committed locally but not in the store yet (local-only cycles, or a crash). */
      readonly unpublishedDays: number;
      readonly pulledDays: number;
      /** Days the backfill or re-derive walk still has to visit. Non-zero shows "Catching up". */
      readonly deriveDaysLeft: number;
    };

export type Warning =
  | { readonly kind: 'rollback'; readonly peer: DeviceId }
  /** A file disagrees with its manifest (torn, placeholder, still syncing). Its last good copy stands. */
  | { readonly kind: 'not-yet'; readonly peer: DeviceId; readonly file: string }
  | { readonly kind: 'unknown-codec'; readonly peer: DeviceId; readonly codec: string }
  /** A peer runs a newer envelope format, or a newer version of a log type. Its file is skipped. */
  | { readonly kind: 'newer-version'; readonly peer: DeviceId; readonly file: string; readonly version: number }
  | { readonly kind: 'foreign-file'; readonly name: string }
  /** A device in the folder seals with a different sync key. It is not a peer; its name is unreadable. */
  | { readonly kind: 'other-key'; readonly peer: DeviceId }
  | { readonly kind: 'rejoined'; readonly previous: DeviceId };

export type Peer = { readonly device: DeviceId; readonly name: string; readonly lastSeen: number; readonly idle: boolean };

export type PeerExtensions = { readonly device: DeviceId; readonly name: string; readonly extensions: ExtensionList };

/** Setup's second screen. Turns the silent first-join adoption into something the user sees before Start. */
export type JoinPreview =
  | { readonly kind: 'not-ready'; readonly store: StoreStatus }
  | { readonly kind: 'first-device'; readonly label: string; readonly bookmarks: number }
  /** Devices sync here under another key, and none under this one. Setup asks for theirs. */
  | { readonly kind: 'needs-key'; readonly label: string; readonly devices: number }
  | {
      readonly kind: 'joining';
      readonly label: string;
      readonly peers: readonly string[];
      readonly bookmarks: { readonly matched: number; readonly toAdd: number; readonly toPublish: number };
      readonly historyDays: number;
    };

// ---------- What the two model cycles share with the engine (internal) ----------

/**
 * Store use within one cycle. `null` inside means a local-only cycle. The first StoreError trips the fuse, so
 * the rest of the cycle runs local-only against last good copies instead of failing half way.
 */
export class StoreFuse {
  #store: Store | null;
  #failure: StoreFailure | null = null;

  constructor(store: Store | null) {
    this.#store = store;
  }

  get available(): boolean {
    return this.#store !== null;
  }

  get failure(): StoreFailure | null {
    return this.#failure;
  }

  /** `fn` against the store, or null when there is none. */
  async use<T>(fn: (store: Store) => Promise<T>): Promise<T | null> {
    if (this.#store === null) return null;
    try {
      return await fn(this.#store);
    } catch (error) {
      if (!(error instanceof StoreError)) throw error;
      this.#failure = error.why;
      this.#store = null;
      return null;
    }
  }
}

export type CycleContext = {
  readonly me: DeviceLocal;
  readonly store: StoreFuse;
  /** Live peers' last good manifests. Without a store, the ones we held. */
  readonly live: ReadonlyMap<DeviceId, Manifest>;
  readonly cipher: Cipher;
  readonly now: number;
  readonly budget: Budget;
  readonly policy: Policy;
};

/** One file this device wants in the store. `body` is built only when `plain` differs from what was published. */
export type Wanted = { readonly plain: string; readonly body: () => Promise<Json> };

// ---------- The engine ----------

/** Commit a change to this device's local state. The engine's one writer of DeviceLocal within a cycle. */
type Save = (update: (me: DeviceLocal) => DeviceLocal) => Promise<void>;

const isLive = (manifest: Manifest, now: number, policy: Policy) => now - manifest.lastSeen <= policy.idleAfterDays * DAY_MS;

function livePeers(peers: ReadonlyMap<DeviceId, PeerLocal>, now: number, policy: Policy): ReadonlyMap<DeviceId, Manifest> {
  const live = new Map<DeviceId, Manifest>();
  for (const [device, peer] of peers) if (peer.manifest !== null && isLive(peer.manifest, now, policy)) live.set(device, peer.manifest);
  return live;
}

function mintDeviceId(): DeviceId {
  const id = crypto.randomUUID();
  if (!isDeviceId(id)) throw new Error(`randomUUID gave ${id}`);
  return id;
}

export function createEngine(deps: EngineDeps): Engine {
  const policy: Policy = { ...defaultPolicy, ...deps.policy };

  const statusOf = (conn: StoreConnection, fuse: StoreFuse): StoreStatus => {
    if (conn.access !== 'ready') return conn;
    const failure = fuse.failure;
    return failure === null ? { access: 'ready', label: conn.label } : { access: 'failed', label: conn.label, why: failure };
  };

  /**
   * Refresh peer manifests through one cheap `get` each. Peers whose folder is gone leave, and so do devices
   * under another key; the rest keep their last good copy.
   */
  async function fetchPeers(
    fuse: StoreFuse,
    cipher: Cipher,
    self: DeviceId,
    held: ReadonlyMap<DeviceId, PeerLocal>,
    warnings: Warning[],
  ): Promise<ReadonlyMap<DeviceId, PeerLocal>> {
    const names = await fuse.use((store) => store.list(DEVICES_PREFIX));
    if (names === null) return held;
    const peers = new Map<DeviceId, PeerLocal>();
    for (const name of names) {
      if (!isDeviceId(name)) {
        warnings.push({ kind: 'foreign-file', name });
        continue;
      }
      if (name === self) continue;
      const known: PeerLocal = held.get(name) ?? { version: null, manifest: null };
      const fetched = await fuse.use((store) => store.get(keys.manifest(name), known.version));
      if (fetched === null) return held;
      if (fetched.kind !== 'ok') {
        peers.set(name, known);
        continue;
      }
      const opened = await openManifest(fetched.bytes, name, cipher);
      switch (opened.kind) {
        case 'ok': {
          const { manifest } = opened;
          if (known.manifest !== null && manifest.seq < known.manifest.seq) {
            warnings.push({ kind: 'rollback', peer: name });
            peers.set(name, { version: fetched.version, manifest: known.manifest });
          } else peers.set(name, { version: fetched.version, manifest });
          break;
        }
        case 'other-key':
          warnings.push({ kind: 'other-key', peer: name });
          break;
        case 'not-yet':
          warnings.push({ kind: 'not-yet', peer: name, file: 'manifest.json' });
          peers.set(name, known);
          break;
        case 'newer-format':
          warnings.push({ kind: 'newer-version', peer: name, file: 'manifest.json', version: opened.formatVersion });
          peers.set(name, known);
          break;
        case 'unknown-codec':
          warnings.push({ kind: 'unknown-codec', peer: name, codec: opened.codec });
          peers.set(name, known);
          break;
        default: {
          const unreachable: never = opened;
          return unreachable;
        }
      }
    }
    return peers;
  }

  /** Null unless it opens with our key: a manifest under another key at our DeviceId is not ours to compare. */
  async function ownManifest(fuse: StoreFuse, cipher: Cipher, me: DeviceLocal): Promise<Manifest | null> {
    const fetched = await fuse.use((store) => store.get(keys.manifest(me.device), null));
    if (fetched?.kind !== 'ok') return null;
    const opened = await openManifest(fetched.bytes, me.device, cipher);
    return opened.kind === 'ok' ? opened.manifest : null;
  }

  async function deleteOwnFiles(store: Store, me: DeviceLocal): Promise<void> {
    for (const rel of me.published.keys()) await store.delete(keys.file(me.device, rel));
    await store.delete(keys.manifest(me.device));
  }

  async function cycle({ budget, asks }: CycleOptions): Promise<SyncReport> {
    const now = deps.clock.now();
    const loaded = await deps.local.load();
    if (loaded === null) return { kind: 'needs-setup', at: now };
    let me: DeviceLocal = loaded;
    const cipher = await cipherFor(me.key);
    const conn = await deps.connect();
    const fuse = new StoreFuse(conn.access === 'ready' ? conn.store : null);
    const warnings: Warning[] = [];

    // Idle past the window: peers have GC'd around us, so rejoin as a new device by adoption.
    if (me.lastSeen !== null && now - me.lastSeen > policy.idleAfterDays * DAY_MS && fuse.available) {
      const idle = me;
      const deleted = await fuse.use((store) => deleteOwnFiles(store, idle));
      if (deleted !== null) {
        // The profile choice rides along like the setup choices; the first save below persists it.
        me = { ...(await deps.local.reset({ name: idle.name, historyOn: idle.historyOn, key: idle.key })), profile: idle.profile };
        warnings.push({ kind: 'rejoined', previous: idle.device });
      }
    }

    const ours = await ownManifest(fuse, cipher, me);
    if (ours !== null && ours.seq > me.manifestSeq) return { kind: 'identity-clash', at: now, device: me.device };

    const force = asks.applyDeletions > me.handled.applyDeletions;
    const rederive = asks.rederiveHistory > me.handled.rederiveHistory;
    // `handled` rides along with the first save of this cycle, so an ask is acted on exactly once.
    me = { ...me, peers: await fetchPeers(fuse, cipher, me.device, me.peers, warnings), handled: asks };
    const live = livePeers(me.peers, now, policy);
    const ctx: CycleContext = { me, store: fuse, live, cipher, now, budget, policy };
    const save: Save = async (update) => {
      me = update(me);
      await deps.local.save(me);
    };

    const b = await syncRegisters(ctx, bookmarks, deps.bookmarks, me.bookmarks, { force, commit: (next, clock) => save((m) => ({ ...m, bookmarks: next, clock })) });
    warnings.push(...b.warnings);
    // A fresh context: the reading list ticks the clock bookmarks just committed, so stamps never go backwards.
    const r = await syncRegisters({ ...ctx, me }, readingList, deps.readingList, me.readingList, {
      force,
      commit: (next, clock) => save((m) => ({ ...m, readingList: next, clock })),
    });
    warnings.push(...r.warnings);
    // Full profile mode, each type with a fresh context for the same reason. Off: the three neither run nor
    // publish (their files leave our manifest, peers keep what they merged), and their state waits untouched.
    const profile = deps.profile;
    const s =
      profile === null
        ? null
        : await syncRegisters({ ...ctx, me }, settings, profile.settings, me.settings, { force, commit: (next, clock) => save((m) => ({ ...m, settings: next, clock })) });
    const e =
      profile === null
        ? null
        : await syncRegisters({ ...ctx, me }, searchEngines, profile.searchEngines, me.searchEngines, {
            force,
            commit: (next, clock) => save((m) => ({ ...m, searchEngines: next, clock })),
          });
    const a =
      profile === null
        ? null
        : await syncRegisters({ ...ctx, me }, addresses, profile.addresses, me.addresses, { force, commit: (next, clock) => save((m) => ({ ...m, addresses: next, clock })) });
    for (const step of [s, e, a]) if (step !== null) warnings.push(...step.warnings);
    const h = me.historyOn ? await syncLog(ctx, history, deps.history, me.history, { rederive, commit: (cursor) => save((m) => ({ ...m, history: cursor })) }) : null;
    if (h !== null) warnings.push(...h.warnings);
    const x = await syncSnapshot(ctx, extensions, deps.extensions, me.extensions);
    warnings.push(...x.warnings);
    await save((m) => ({
      ...m,
      bookmarks: b.local,
      readingList: r.local,
      settings: s?.local ?? m.settings,
      searchEngines: e?.local ?? m.searchEngines,
      addresses: a?.local ?? m.addresses,
      history: h === null ? m.history : h.cursor,
      extensions: x.local,
    }));

    const wanted = new Map<RelName, Wanted>([...b.wanted, ...r.wanted, ...(s?.wanted ?? []), ...(e?.wanted ?? []), ...(a?.wanted ?? []), ...(h?.wanted ?? []), ...x.wanted]);
    const settled = await publish(fuse, cipher, me, ours, wanted, now, save);
    if (settled && h !== null) for (const day of h.expired) await deps.history.local.deleteOwnDay(day);
    // Counted after publish, so a cycle that just put its days reports them as published.
    let publishedDays = 0;
    for (const [rel, want] of h?.wanted ?? []) if (me.published.get(rel)?.plain === want.plain) publishedDays++;
    const historyOutcome: LogOutcome =
      h === null ? { kind: 'off' } : h.outcome.kind === 'off' ? h.outcome : { ...h.outcome, publishedDays, unpublishedDays: h.wanted.size - publishedDays };

    const peers: Peer[] = [];
    for (const [device, peer] of me.peers)
      if (peer.manifest !== null) peers.push({ device, name: peer.manifest.name, lastSeen: peer.manifest.lastSeen, idle: !live.has(device) });
    const peerExtensions: PeerExtensions[] = [];
    for (const [device, held] of x.local.peers) {
      const manifest = live.get(device);
      if (manifest !== undefined) peerExtensions.push({ device, name: manifest.name, extensions: held.content });
    }
    const off: RegisterOutcome = { kind: 'off' };
    const registers = [b.outcome, r.outcome, s?.outcome ?? off, e?.outcome ?? off, a?.outcome ?? off];
    return {
      kind: 'cycle',
      device: me.device,
      name: me.name,
      at: now,
      complete: registers.every((o) => o.kind !== 'pending' || o.why !== 'budget') && (h?.complete ?? true),
      store: statusOf(conn, fuse),
      bookmarks: b.outcome,
      readingList: r.outcome,
      settings: s?.outcome ?? off,
      searchEngines: e?.outcome ?? off,
      addresses: a?.outcome ?? off,
      history: historyOutcome,
      extensions: peerExtensions,
      peers,
      warnings,
    };
  }

  /**
   * Changed files, then the record of them, then the manifest, then the files that left it. `published` keeps a
   * gone file until its delete succeeded, so a store error between the manifest and the deletes retries them.
   * Returns false when the fuse tripped before the store matched what we wanted.
   */
  async function publish(
    fuse: StoreFuse,
    cipher: Cipher,
    me: DeviceLocal,
    ours: Manifest | null,
    wanted: ReadonlyMap<RelName, Wanted>,
    now: number,
    save: Save,
  ): Promise<boolean> {
    if (!fuse.available) return false;
    const published = new Map<RelName, Published>();
    let changed = false;
    for (const [rel, want] of wanted) {
      const held = me.published.get(rel);
      // Unchanged content whose bytes the store's own manifest still vouches for. A rolled-back or hand-deleted
      // file shows up as a hash the manifest no longer names, and is put again.
      if (held !== undefined && held.plain === want.plain && ours?.files.get(rel)?.hash === held.hash) {
        published.set(rel, held);
        continue;
      }
      const key = keys.file(me.device, rel);
      const sealed = await seal(await want.body(), cipher, key);
      const put = await fuse.use((store) => store.put(key, sealed.bytes));
      if (put === null) return false;
      published.set(rel, { plain: want.plain, ...sealed.entry });
      changed = true;
    }
    const gone = new Map([...me.published].filter(([rel]) => !wanted.has(rel)));
    const heartbeatDue = me.lastSeen === null || now - me.lastSeen >= policy.heartbeatHours * 3_600_000;
    const manifestStale = ours === null || ours.seq !== me.manifestSeq;
    if (changed || gone.size > 0 || heartbeatDue || manifestStale) {
      const seq = me.manifestSeq + 1;
      await save((m) => ({ ...m, published: new Map([...published, ...gone]), manifestSeq: seq, lastSeen: now }));
      const manifest: Manifest = {
        formatVersion: FORMAT_VERSION,
        device: me.device,
        name: me.name,
        platform: deps.platform,
        app: { name: 'helium-sync', version: deps.appVersion },
        seq,
        lastSeen: now,
        files: new Map([...published].map(([rel, p]) => [rel, { hash: p.hash, bytes: p.bytes }])),
      };
      const bytes = await sealManifest(manifest, cipher);
      const put = await fuse.use((store) => store.put(keys.manifest(me.device), bytes));
      if (put === null) return false;
    }
    for (const rel of gone.keys()) {
      const deleted = await fuse.use((store) => store.delete(keys.file(me.device, rel)));
      if (deleted === null) return false;
    }
    if (gone.size > 0) await save((m) => ({ ...m, published }));
    return true;
  }

  /**
   * The fetch and the bookmark merge as a fresh device. Only the channel's minted ids are written, as a real first
   * cycle would. Peers are the devices that open with `key`; any others only make it `needs-key`.
   */
  async function preview(key: SyncKey): Promise<JoinPreview> {
    const now = deps.clock.now();
    const conn = await deps.connect();
    if (conn.access !== 'ready') return { kind: 'not-ready', store: conn };
    const fuse = new StoreFuse(conn.store);
    const cipher = await cipherFor(key);
    const self = (await deps.local.load())?.device ?? mintDeviceId();
    const warnings: Warning[] = [];
    const peers = await fetchPeers(fuse, cipher, self, new Map(), warnings);
    const others = warnings.filter((w) => w.kind === 'other-key').length;
    if (peers.size === 0 && others > 0) return { kind: 'needs-key', label: conn.label, devices: others };
    const live = livePeers(peers, now, policy);
    const me: DeviceLocal = { ...freshDeviceLocal(self, { name: '', historyOn: true, key }, joinCursor(now, history.retentionDays)), peers };
    const ctx: CycleContext = { me, store: fuse, live, cipher, now, budget: { expired: () => true }, policy };
    const step = await syncRegisters(ctx, bookmarks, deps.bookmarks, null, { force: false, commit: async () => {}, dryRun: true });
    if (live.size === 0) return { kind: 'first-device', label: conn.label, bookmarks: step.adopted.toPublish };
    let historyDays = 0;
    for (const manifest of live.values()) for (const rel of manifest.files.keys()) if (parseRel(rel)?.kind === 'shard') historyDays++;
    return { kind: 'joining', label: conn.label, peers: [...live.values()].map((m) => m.name), bookmarks: step.adopted, historyDays };
  }

  async function forget(): Promise<void> {
    const me = await deps.local.load();
    if (me === null) return;
    const conn = await deps.connect();
    if (conn.access === 'ready') await deleteOwnFiles(conn.store, me);
    await deps.local.clear();
  }

  function sync(opts: CycleOptions): Promise<SyncReport>;
  function sync(opts: PreviewOptions): Promise<JoinPreview>;
  function sync(opts: CycleOptions | PreviewOptions): Promise<SyncReport | JoinPreview> {
    return 'preview' in opts ? preview(opts.key) : cycle(opts);
  }

  return { sync, forget };
}
