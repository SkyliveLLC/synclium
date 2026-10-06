// PRIVATE to the engine. The only module that knows the bytes in the sync folder.
// Transports move opaque blobs; frontends never see this shape.
//
// Blob = gzip(JSON(DeviceBlobV1)). gzip via the global CompressionStream (Node 24 and browsers alike),
// so the engine stays runtime-agnostic.
//
// Adding a data type does NOT bump the format: unknown `types` keys from newer peers are ignored on read.
// Those peers keep their own data in their own blobs. Bump `v` only when an existing type's shape changes.

import type { Types } from './engine.ts';
import type { DeviceId, Live, Rec, Replica, Stamp } from './model.ts';

/** Decoded, validated blob. The domain-side twin of the private wire type below. */
export type DeviceBlob = {
  readonly device: DeviceId;
  readonly label: string;
  readonly writtenAt: Stamp;
  /** merge types -> stamped replica; publish types -> the author's plain snapshot. Keyed by registry name. */
  readonly types: { readonly [name: string]: { readonly mode: 'merge'; readonly replica: Replica<Rec> } | { readonly mode: 'publish'; readonly live: Live<Rec> } };
};

export type DecodeResult =
  | { readonly kind: 'ok'; readonly blob: DeviceBlob }
  | { readonly kind: 'corrupt'; readonly detail: string }
  | { readonly kind: 'newer-format'; readonly version: number };

// Wire shape. Compact: registers as [value, stamp] tuples, short keys. Never exported.
type WireV1 = {
  v: 1;
  device: string;
  label: string;
  at: string;
  types: { [name: string]: { [syncId: string]: [kind: string, deleted: [boolean, string], fields: { [f: string]: [unknown, string] }] } };
};

/** Parses every stamp, id and field value; each record goes through its DataType.parse. Bad entries drop, not the blob. */
export async function decodeDeviceBlob(bytes: Uint8Array, types: Types): Promise<DecodeResult> {
  throw new Error('not implemented');
}

export async function encodeDeviceBlob(blob: DeviceBlob): Promise<Uint8Array> {
  const _wire: WireV1 | undefined = undefined;
  throw new Error('not implemented');
}
