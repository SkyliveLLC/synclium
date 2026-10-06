// The engine: one deep entry point, `sync()`. It owns ordering, stamping, merging, persistence and the
// write-own-file-only rule. It knows nothing about CLIs, sockets, native messaging, folders or chrome.*:
// those arrive through the three ports below.

import type { Clock, Policy } from './crdt.ts';
import type { AnyDataType, DeviceId, FacetOf, IdMap, Live, RecordOf, Remote, Stamp } from './model.ts';

// ---------- Ports ----------

/** The browser, as reached through the companion extension. Implemented by bridge/native.ts. */
export interface BrowserLink {
  remote<D extends AnyDataType>(type: D): Remote<FacetOf<D>>;
}

/**
 * A dumb blob store with one blob per device. Folder today; S3, WebDAV, a hosted server later.
 * Each device writes only its own blob, so no two writers ever share a key (no folder conflicts, no locks).
 */
export interface Transport {
  /** Latest blob of every device, ours included. Names the transport cannot map to a DeviceId are skipped. */
  readAll(): Promise<ReadonlyMap<DeviceId, Uint8Array>>;
  /** Atomically replace our blob (folder: temp file + rename). */
  writeOwn(self: DeviceId, blob: Uint8Array): Promise<void>;
  removeOwn(self: DeviceId): Promise<void>;
  /** Best-effort change hint; the host also polls. Returns an unsubscribe function. */
  watch(onChange: () => void): () => void;
}

/** Local, per-device engine state. Lives outside Helium's data dir (host/paths.ts). */
export interface ReplicaStore {
  load(device: DeviceId): Promise<ReplicaState | null>;
  /** Atomic replace. */
  save(state: ReplicaState): Promise<void>;
}

export type Types = { readonly [name: string]: AnyDataType };

/** Present for a merge type once it has joined. Absent = next sync runs that type's first-join adoption. */
export type TypeState<D extends AnyDataType> = { readonly ids: IdMap; readonly view: Live<RecordOf<D>> };

export type ReplicaState<T extends Types = Types> = {
  readonly device: DeviceId;
  readonly clock: Clock;
  /** writtenAt of the last blob we wrote. A newer own blob we did not write means a cloned profile. */
  readonly lastWrittenAt: Stamp | undefined;
  readonly types: { readonly [K in keyof T]?: TypeState<T[K]> };
};

// ---------- Outcome ----------

export type Peer = { readonly device: DeviceId; readonly label: string; readonly writtenAt: Date; readonly evicted: boolean };
export type TypeReport = {
  /** Fields this device stamped this run. */
  readonly pushed: number;
  /** Browser operations performed this run. */
  readonly applied: number;
  readonly failed: readonly { readonly item: string; readonly error: string }[];
};

export type Blocked =
  | { readonly kind: 'store-unreachable'; readonly detail: string }
  /** A peer wrote a format this build cannot read. We stop rather than silently drop its fields. */
  | { readonly kind: 'newer-format'; readonly peer: DeviceId }
  /** Another installation writes our DeviceId (a copied profile). Fix: reinstall the extension on one of them. */
  | { readonly kind: 'identity-clash' }
  /** The extension disconnected mid-run. Nothing is lost; the next connect resumes. */
  | { readonly kind: 'browser-gone' };

export type SyncOutcome =
  | {
      readonly kind: 'synced';
      readonly at: Date;
      readonly wroteStore: boolean;
      readonly types: { readonly [name: string]: TypeReport };
      readonly peers: readonly Peer[];
    }
  | { readonly kind: 'blocked'; readonly reason: Blocked };

// ---------- Engine ----------

export type EngineDeps<T extends Types> = {
  readonly self: DeviceId;
  /** Shown to peers, e.g. "conan-mbp". */
  readonly label: string;
  readonly types: T;
  readonly browser: BrowserLink;
  readonly transport: Transport;
  readonly replicas: ReplicaStore;
  readonly now?: () => number;
  readonly policy?: Partial<Policy>;
};

export interface Engine {
  /**
   * Converge browser and store. Single-flight: a call made while a run is in progress resolves with the
   * next run, so "I changed something, then asked for sync" always includes the change.
   * Idempotent: a second run with nothing new reads, finds no diff, writes nothing.
   */
  sync(): Promise<SyncOutcome>;
  /** Delete our blob from the store (uninstall --forget). Peers keep everything we contributed. */
  forget(): Promise<void>;
}

export function createEngine<T extends Types>(deps: EngineDeps<T>): Engine {
  // One run, in this order (crash at any arrow is safe; see DESIGN.md "Crash walk"):
  //  1. state   = replicas.load(self) ?? fresh(self)
  //  2. blobs   = transport.readAll() -> decodeDeviceBlob each (storeFormat.ts)
  //               corrupt -> skip that peer this run (its data still lives in every other full-state blob)
  //               newer-format -> return blocked; own blob with writtenAt > state.lastWrittenAt -> identity-clash
  //               writtenAt older than evictAfterDays -> drop from merge, report as evicted
  //  3. {clock, stamp} = tick(state.clock, now, newestStamp(all blobs), self)
  //  for each merge type D (publish types: observe -> put own snapshot; no merge, no realize):
  //  4. remote   = mergeReplicas(blob replicas of D, ours included)
  //  5. observed = D.observe(browser.remote(D), { ids, known: view overlaid on materialize(remote), mint })
  //  6. merged   = foldLocalChanges(remote, typeState?.view ?? null, observed.live, stamp)
  //               merged = collectGarbage(merged, live peers)
  //  7. target   = materialize(merged, D.normalize)
  //  8. if shouldWrite(changed vs own blob, ...) -> transport.writeOwn(self, encodeDeviceBlob(...))   [publish first]
  //  9. realized = D.realize(browser.remote(D), target, observed)                                 [then apply]
  // 10. replicas.save({ ..., types[D] = { ids: realized.ids, view: target }, clock, lastWrittenAt })
  throw new Error('not implemented');
}
