// The deep module. The scheduler calls `sync` once per wake; the report lands in chrome.storage.local for the
// popup. Store access, manifests, merging, stamping, adoption, GC, idle handling, rollback checks, log shards,
// budgets, and crash ordering all live behind two methods.
//
// The engine holds nothing between calls and takes no lock (the scheduler holds the Web Lock). The runtime
// builds one per wake from IndexedDB, so "terminated mid-cycle" and "crashed mid-cycle" are the same event.
import type { DeviceId, Json } from './model.ts';
import type { Bookmark } from './bookmarks.ts';
import type { Visit } from './history.ts';
import type { Asks, Budget, Clock, DeviceLocal, LocalState, LogPorts, RegisterChannel, Store, StoreConnection, StoreStatus } from './ports.ts';
import type { Codec, Manifest, Platform } from './store-format.ts';

export type EngineDeps = {
  /** folder-store.ts `connectFolder`. Called once at the start of every cycle. */
  readonly connect: () => Promise<StoreConnection>;
  readonly local: LocalState;
  readonly bookmarks: RegisterChannel<Bookmark>;
  readonly history: LogPorts<Visit>;
  readonly codec: Codec;
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

export interface Engine {
  /** One bounded cycle. Idempotent. `complete: false` means the budget ran out and the next wake continues. */
  sync(opts: CycleOptions): Promise<SyncReport>;
  /** What joining this store as a fresh device would do. Writes nothing to the store or to sync state. */
  sync(opts: { readonly preview: true }): Promise<JoinPreview>;
  /** Delete this device's files (every file our manifest lists, then the manifest) and clear local state. */
  forget(): Promise<void>;
}

export function createEngine(_deps: EngineDeps): Engine {
  throw new Error('not implemented');
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
      readonly history: LogOutcome;
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
  | { readonly kind: 'blocked'; readonly why: Blocked };

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
  | { readonly kind: 'foreign-file'; readonly name: string }
  | { readonly kind: 'rejoined'; readonly previous: DeviceId };

export type Peer = { readonly device: DeviceId; readonly name: string; readonly lastSeen: number; readonly idle: boolean };

/** Setup's second screen. Turns the silent first-join adoption into something the user sees before Start. */
export type JoinPreview =
  | { readonly kind: 'not-ready'; readonly store: StoreStatus }
  | { readonly kind: 'first-device'; readonly label: string; readonly bookmarks: number }
  | {
      readonly kind: 'joining';
      readonly label: string;
      readonly peers: readonly string[];
      readonly bookmarks: { readonly matched: number; readonly toAdd: number; readonly toPublish: number };
      readonly historyDays: number;
    };

// ---------- What the two model cycles share with the engine (internal) ----------

export type CycleContext = {
  readonly me: DeviceLocal;
  /** null for a local-only cycle. A StoreError mid-cycle ends store use for the rest of the cycle. */
  readonly store: Store | null;
  /** Live peers' last good manifests. Without a store, the ones we held. */
  readonly live: ReadonlyMap<DeviceId, Manifest>;
  readonly codec: Codec;
  readonly now: number;
  readonly budget: Budget;
  readonly policy: Policy;
};

/** One file this device wants in the store. `body` is built only when `plain` differs from what was published. */
export type Wanted = { readonly plain: string; readonly body: () => Promise<Json> };

/*
 * sync({ budget, asks }):
 *
 *   me    = local.load(); null -> needs-setup
 *   conn  = connect()                                  // the only place access is decided
 *   store = conn.access === 'ready' ? conn.store : null
 *
 *   ---- fetch (store only; one cheap get per peer when nothing changed)
 *   me.lastSeen older than idleAfterDays: delete the files our manifest lists; me = local.reset(...); warn rejoined
 *   ours = store.get(keys.manifest(me), null); ours.seq > me.manifestSeq      -> return identity-clash
 *   ids  = store.list('devices/') as DeviceIds; any other name warns foreign-file
 *   per peer p: store.get(keys.manifest(p), me.peers[p].version)
 *     unchanged -> keep; missing -> keep last good (placeholder) unless p's folder is gone from `ids`
 *     ok        -> parseManifest; seq below last good -> warn rollback, keep last good
 *   live = peers whose manifest.lastSeen is within idleAfterDays
 *
 *   ---- the two models, one function each. Budget is checked between units, never inside one.
 *   force = asks.applyDeletions > me.handled.applyDeletions
 *   b = syncRegisters(ctx, bookmarks, deps.bookmarks, me.bookmarks, force)    // one unit; apply checks budget per call
 *   h = me.historyOn ? syncLog(ctx, history, deps.history, me.history, asks.rederiveHistory > me.handled.rederiveHistory)
 *                    : off, wanting no history files
 *   local.save(me with b.local, h.cursor, handled = asks)                       // before any put: commit, then publish
 *
 *   ---- publish (store only). The manifest is the commit point, so it goes last.
 *   wanted = b.wanted + h.wanted                       // every own file, touched this cycle or not
 *   per rel in wanted with plain != me.published[rel].plain: seal(body()), put
 *   gone   = rels in me.published not in wanted        // expired days, or history turned off
 *   if anything was put, `gone` is non-empty, or heartbeatHours elapsed:
 *     put manifest { seq: manifestSeq + 1, lastSeen: now, files: wanted entries }
 *   local.save(published, manifestSeq, lastSeen)       // after the manifest: a crash re-puts identical bytes
 *   per rel in gone: store.delete; expired days also leave LogLocal now, never before their file is gone
 *
 *   complete = no unit was cut by the budget
 *
 * Crash anywhere converges. Own state is committed before publish. `applied` moves only on proof. Adoption
 * claims bookmark nodes an interrupted apply created. A file put without its manifest is invisible to readers,
 * and a manifest naming bytes that never landed reads as "not yet".
 *
 * Preview runs the fetch and the bookmark merge as a fresh device (applied = null) and stops before any write
 * except the chrome id map, whose minted ids the real first cycle would mint anyway.
 */
