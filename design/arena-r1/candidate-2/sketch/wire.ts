// The only module that knows the on-store byte format. Everything crossing the Store boundary is parsed here
// into domain types; nothing above this file sees the JSON shape.
//
// Store layout (all per-device, zero shared files):
//   devices/<deviceId>/device.json          DeviceCard
//   devices/<deviceId>/<type>.json.gz       DeviceState<F> for one type
//   (nothing else; format version travels inside each file)

import type { DataType, DeviceId, DeviceState, Fields, Stamp } from './datatype.ts';

export const FORMAT_VERSION = 1;

/** Presence record: who is in the store, how to name them, and when they last synced (drives GC and eviction). */
export type DeviceCard = {
  readonly id: DeviceId;
  readonly name: string;
  readonly platform: 'darwin' | 'linux' | 'win32';
  readonly lastSync: Stamp;
  readonly format: typeof FORMAT_VERSION;
};

export const paths = {
  device: (id: DeviceId) => `devices/${id}/device.json`,
  state: (id: DeviceId, type: string) => `devices/${id}/${type}.json.gz`,
  /** Parses `devices/<id>/...` back into a DeviceId, or null for anything else (conflict copies, .DS_Store). */
  deviceIdOf: (path: string): DeviceId | null => {
    throw new Error('not implemented');
  },
} as const;

export function encodeCard(card: DeviceCard): Uint8Array {
  throw new Error('not implemented');
}
/** Returns null for unparseable or newer-format bytes; the engine reports and skips that device. */
export function decodeCard(bytes: Uint8Array): DeviceCard | null {
  throw new Error('not implemented');
}

/** gzip(JSON). Deterministic key order so identical states produce identical bytes (idempotent re-upload). */
export function encodeState<F extends Fields>(state: DeviceState<F>): Uint8Array {
  throw new Error('not implemented');
}
/**
 * Validates structure against `type.fieldKeys`: every item must have a register for every key and a `deleted`
 * register; stamps must match the fixed-width pattern. Items failing validation are dropped, not guessed at.
 */
export function decodeState<F extends Fields>(bytes: Uint8Array, type: DataType<F>): DeviceState<F> {
  throw new Error('not implemented');
}

/** sha256 of the encoded bytes; stored locally as `pushedHash` so we skip re-uploading unchanged state. */
export function contentHash(bytes: Uint8Array): string {
  throw new Error('not implemented');
}
