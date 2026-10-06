// The only module that knows store key names and bytes. Transports move opaque bytes.
// Round 1 (sketch-cli-synthesis/store-format.ts) with these changes, all forced by the MV3 runtime or by history:
//   - Keys gain a shard segment (history is one file per device per day).
//   - The codec is CompressionStream and the hash is WebCrypto. There is no node:zlib or node:crypto in a
//     service worker. Both are async, so `seal`, `open`, and `plaintextHash` return promises.
//   - Everything else (envelope, per-device single-writer layout, acked, rollback seq) is unchanged.
//
// Layout. Every key has exactly one writer, so a dumb sync folder never sees a write-write conflict.
//   devices/<deviceId>/meta.json                       DeviceMeta, plain JSON
//   devices/<deviceId>/bookmarks/all.json.gz           envelope header line + gzip body holding a StateFile
//   devices/<deviceId>/history/2026-10-06.json.gz      one shard per UTC day, same shape
import type { Brand, DataType, DeviceId, Hlc, Json, Rec, Replica, ShardKey } from './model.ts';
import type { Acked } from './crdt.ts';

export type StoreKey = Brand<string, 'StoreKey'>;

export const DEVICES_PREFIX = 'devices/';

export const keys = {
  meta: (_device: DeviceId): StoreKey => {
    throw new Error('not implemented');
  },
  state: (_device: DeviceId, _type: string, _shard: ShardKey): StoreKey => {
    throw new Error('not implemented');
  },
};

/**
 * Strict. Dropbox "(conflicted copy)" files, Syncthing `.syncthing.*.tmp`, Chromium's `.crswap` (the swap
 * file an FSA writable stream commits from), iCloud `.<name>.icloud` placeholders, and `.DS_Store` all
 * return null. The engine reports them and never merges them.
 */
export type ParsedKey =
  | { readonly kind: 'meta'; readonly device: DeviceId; readonly key: StoreKey }
  | { readonly kind: 'state'; readonly device: DeviceId; readonly type: string; readonly shard: ShardKey; readonly key: StoreKey };
export function parseKey(_name: string): ParsedKey | null {
  throw new Error('not implemented');
}

// ---------- Envelope and codec ----------
// A state file is one plaintext header line, then a codec body:
//   {"magic":"helium-sync","formatVersion":1,"codec":"gzip-json"}\n<body bytes>
// Unchanged from round 1. v1 does not encrypt. A later codec id plus a pairing flow adds encryption
// without touching layout or header.

export const FORMAT_VERSION = 1;
export type CodecId = 'gzip-json';
export type Envelope = { readonly magic: 'helium-sync'; readonly formatVersion: typeof FORMAT_VERSION; readonly codec: CodecId };

export interface Codec {
  readonly id: CodecId;
  encode(body: Json): Promise<Uint8Array>;
  decode(bytes: Uint8Array): Promise<{ readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly detail: string }>;
}

/** gzip of canonical JSON (sorted keys) through CompressionStream / DecompressionStream. */
export const gzipJson: Codec = {
  id: 'gzip-json',
  encode: () => {
    throw new Error('not implemented');
  },
  decode: () => {
    throw new Error('not implemented');
  },
};

export function seal(_body: Json, _codec: Codec): Promise<Uint8Array> {
  throw new Error('not implemented');
}

export type Opened =
  | { readonly kind: 'ok'; readonly body: unknown }
  /** Truncated upload, partial sync, garbage. "Not yet", never fatal. */
  | { readonly kind: 'unreadable'; readonly detail: string }
  | { readonly kind: 'newer-format'; readonly formatVersion: number }
  /** A peer encrypts and this device has not paired yet. */
  | { readonly kind: 'unknown-codec'; readonly codec: string };

/** Never throws on bad input. */
export function open(_bytes: Uint8Array, _codec: Codec): Promise<Opened> {
  throw new Error('not implemented');
}

/** sha256 (WebCrypto) of the canonical plaintext. Stored locally as `pushedHash` to skip unchanged publishes. */
export function plaintextHash(_body: Json): Promise<string> {
  throw new Error('not implemented');
}

// ---------- Bodies ----------

export type StateFile<R extends Rec> = {
  readonly device: DeviceId;
  readonly type: string;
  readonly shard: ShardKey;
  readonly typeVersion: number;
  /**
   * Monotonic per device, type, and shard. A peer file with a lower seq than already seen is a cloud
   * rollback. Merging it could resurrect items whose tombstones were already collected, so it is skipped.
   * Our own file with a higher seq than local state means another installation writes our DeviceId.
   */
  readonly seq: number;
  readonly writtenAt: Hlc;
  readonly acked: Acked;
  /** The device's full merged state for this shard, not a delta. Any one live file carries everything its author saw. */
  readonly replica: Replica<R>;
};

export function encodeStateFile<R extends Rec>(_file: StateFile<R>): Json {
  throw new Error('not implemented');
}

export type ParsedState<R extends Rec> =
  | { readonly kind: 'ok'; readonly file: StateFile<R> }
  | { readonly kind: 'newer-type-version'; readonly version: number }
  /** Includes a body whose device, type, or shard disagrees with the key it was read from. */
  | { readonly kind: 'invalid'; readonly detail: string };

/** Validates every stamp, id, and register shape, then each record through `type.parseRecord`. Bad entries drop. */
export function parseStateFile<R extends Rec>(
  _body: unknown,
  _type: DataType<R>,
  _at: { readonly device: DeviceId; readonly type: string; readonly shard: ShardKey },
): ParsedState<R> {
  throw new Error('not implemented');
}

export type Platform = 'mac' | 'linux' | 'win' | 'cros' | 'android' | 'openbsd' | 'fuchsia'; // chrome.runtime.PlatformOs

/** Presence record. Plain JSON on purpose: it holds no profile data, and the popup can read it without a codec. */
export type DeviceMeta = {
  readonly formatVersion: typeof FORMAT_VERSION;
  readonly device: DeviceId;
  readonly name: string;
  readonly platform: Platform;
  readonly app: { readonly name: 'helium-sync'; readonly version: string };
  /** Wall ms. Rewritten at least every heartbeat. Drives idle detection, so clock skew shifts it (accepted). */
  readonly lastSeen: number;
};

export function encodeMeta(_meta: DeviceMeta): Uint8Array {
  throw new Error('not implemented');
}
export function parseMeta(_bytes: Uint8Array, _at: DeviceId): DeviceMeta | null {
  throw new Error('not implemented');
}
