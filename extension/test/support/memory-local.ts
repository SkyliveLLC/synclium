// In-memory LocalState, LogLocal, and LogSink. What IndexedDB does in local.ts, without the policy.
import { dayOf, isDeviceId, type DayKey, type DeviceId, type EventKey } from '../../src/model.ts';
import { history, type Visit } from '../../src/history.ts';
import { freshDeviceLocal, type DeviceLocal, type LocalState, type LogLocal, type LogSink, type OwnDay, type PeerRef } from '../../src/ports.ts';
import { joinCursor } from '../../src/log-cycle.ts';
import type { StoreKey } from '../../src/store-format.ts';

export function deviceId(n: number): DeviceId {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  if (!isDeviceId(id)) throw new Error(id);
  return id;
}

export type MemoryLocal = LocalState & { readonly state: () => DeviceLocal | null };

/** `ids` mints the DeviceId each `reset` uses, so a scenario can be replayed with the same identities. */
export function memoryLocal(clock: { now(): number }, ids: () => DeviceId): MemoryLocal {
  let state: DeviceLocal | null = null;
  return {
    state: () => state,
    load: async () => state,
    save: async (next) => {
      state = next;
    },
    reset: async (setup) => {
      state = freshDeviceLocal(ids(), setup, joinCursor(clock.now(), history.retentionDays));
      return state;
    },
    clear: async () => {
      state = null;
    },
  };
}

export type MemoryLogLocal = LogLocal<Visit> & {
  readonly days: () => ReadonlyMap<DayKey, readonly Visit[]>;
  readonly ingestedKeys: () => ReadonlySet<EventKey>;
};

export function memoryLogLocal(): MemoryLogLocal {
  const own = new Map<DayKey, { meta: OwnDay; events: readonly Visit[] }>();
  const peerDays = new Map<StoreKey, string>();
  const ingested = new Map<EventKey, number>();
  return {
    days: () => new Map([...own].map(([day, { events }]) => [day, events])),
    ingestedKeys: () => new Set(ingested.keys()),
    ownDays: async () => new Map([...own].map(([day, { meta }]) => [day, meta])),
    ownEvents: async (day) => own.get(day)?.events ?? [],
    saveOwnDay: async (day, events, meta) => {
      own.set(day, { meta, events });
    },
    deleteOwnDay: async (day) => {
      own.delete(day);
    },
    peerDays: async () => new Map(peerDays),
    setPeerDay: async (key, hash) => {
      if (hash === null) peerDays.delete(key);
      else peerDays.set(key, hash);
    },
    ingested: async (keys) => new Set(keys.filter((k) => ingested.has(k))),
    markIngested: async (events) => {
      for (const { key, t } of events) ingested.set(key, t);
    },
    expire: async (before) => {
      for (const [key, t] of ingested) if (t < before) ingested.delete(key);
      const day = dayOf(before);
      for (const key of peerDays.keys()) {
        const match = /\/(\d{4}-\d{2}-\d{2})\.hsync$/.exec(key);
        if (match?.[1] !== undefined && match[1] < day) peerDays.delete(key);
      }
    },
  };
}

export type MemorySink = LogSink<Visit> & {
  /** Everything indexed, as `device -> day -> visits`. */
  readonly indexed: () => ReadonlyMap<DeviceId, ReadonlyMap<DayKey, readonly Visit[]>>;
  readonly visitsFrom: (device: DeviceId) => readonly Visit[];
};

export function memorySink(): MemorySink {
  const index = new Map<DeviceId, Map<DayKey, readonly Visit[]>>();
  const names = new Map<DeviceId, string>();
  return {
    indexed: () => index,
    visitsFrom: (device) => [...(index.get(device)?.values() ?? [])].flat().sort((a, b) => a.t - b.t),
    put: async (from: PeerRef, day, events) => {
      names.set(from.device, from.name);
      let days = index.get(from.device);
      if (days === undefined) index.set(from.device, (days = new Map()));
      for (const e of events) if (dayOf(e.t) !== day) throw new Error(`sink got ${e.url} at ${e.t} under ${day}`);
      days.set(day, events);
    },
    drop: async (device, day) => {
      const days = index.get(device);
      days?.delete(day);
      if (days?.size === 0) index.delete(device);
    },
  };
}

