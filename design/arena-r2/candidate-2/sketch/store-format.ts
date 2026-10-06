// The only module that knows store key names and bytes. Transports move opaque bytes. UI never sees these shapes.
//
// Layout. Every key has exactly one writer, so no store ever sees a write-write conflict.
//   devices/<deviceId>/manifest.json                 Manifest, plain JSON: presence + index of this device's files
//   devices/<deviceId>/bookmarks.json.gz             envelope + codec body holding a StateFile (register type)
//   devices/<deviceId>/history/<YYYY-MM-DD>.json.gz  envelope + codec body holding a ShardFile (log type)
//
// Why a manifest (round-1 meta.json grew an index): over HTTP every read is a round trip. A device
// publishes its files first and its manifest last, so one conditional GET per peer per cycle answers
// "did anything change, and which files". A reader verifies each downloaded file against the hash in the
// manifest, which also makes a torn or half-finished PUT harmless: it fails the hash and counts as "not yet".
import type { Acked } from './crdt.ts';
import type { Brand, DeviceId, Ev, Hlc, Json, LogType, Rec, RegisterType, Replica, ShardId } from './model.ts';

export type StoreKey = Brand<string, 'StoreKey'>;

export const DEVICES_PREFIX = 'devices/';

export const keys = {
  manifest: (_device: DeviceId): StoreKey => {
    throw new Error('not implemented');
  },
  registers: (_device: DeviceId, _type: string): StoreKey => {
    throw new Error('not implemented');
  },
  shard: (_device: DeviceId, _type: string, _shard: ShardId): StoreKey => {
    throw new Error('not implemented');
  },
  /** `devices/<id>/` so a transport can delete a device's subtree. */
  devicePrefix: (_device: DeviceId): string => {
    throw new Error('not implemented');
  },
};

/** Strict. Anything that is not one of the three shapes above is a foreign name: reported, never merged. */
export type ParsedKey =
  | { readonly kind: 'manifest'; readonly device: DeviceId }
  | { readonly kind: 'registers'; readonly device: DeviceId; readonly type: string }
  | { readonly kind: 'shard'; readonly device: DeviceId; readonly type: string; readonly shard: ShardId };
export function parseKey(_name: string): ParsedKey | null {
  throw new Error('not implemented');
}

// ---------- Manifest ----------

export type Platform = 'darwin' | 'linux' | 'win32';

/** Relative to the device prefix: `bookmarks.json.gz`, `history/2026-10-06.json.gz`. */
export type RelName = Brand<string, 'RelName'>;

export type Manifest = {
  readonly formatVersion: typeof FORMAT_VERSION;
  readonly device: DeviceId;
  readonly name: string;
  readonly platform: Platform;
  readonly app: { readonly name: 'helium-sync'; readonly version: string };
  /** Monotonic per device. A higher seq in the store than we wrote means another installation writes our id. */
  readonly seq: number;
  /** Wall ms. Rewritten at least every heartbeat. Drives idle detection, so clock skew shifts it (accepted). */
  readonly lastSeen: number;
  /** Every file this device currently publishes. Absent = deleted (expired shard, forgotten type). */
  readonly files: { readonly [rel: string]: FileEntry };
};

export type FileEntry = {
  /** sha256 of the sealed bytes as uploaded. Readers verify before parsing. */
  readonly hash: string;
  readonly bytes: number;
};

/** Plain JSON on purpose: it holds no profile data and the popup shows peers without a codec. */
export function encodeManifest(_m: Manifest): Uint8Array {
  throw new Error('not implemented');
}
export function parseManifest(_bytes: Uint8Array, _at: DeviceId): Manifest | null {
  throw new Error('not implemented');
}

// ---------- Envelope and codec ----------
// A sealed file is one plaintext header line, then a codec body:
//   {"magic":"helium-sync","formatVersion":1,"codec":"gzip-json"}\n<body bytes>
// Same bytes as round 1, so a CLI or companion written against round 1 reads these files. End-to-end
// encryption later is a new CodecId plus a pairing-code field. The layout and header do not change.

export const FORMAT_VERSION = 1;
export type CodecId = 'gzip-json';
export type Envelope = { readonly magic: 'helium-sync'; readonly formatVersion: typeof FORMAT_VERSION; readonly codec: CodecId };

export interface Codec {
  readonly id: CodecId;
  /** Deterministic: equal values encode to equal bytes. */
  encode(body: Json): Promise<Uint8Array>;
  decode(bytes: Uint8Array): Promise<{ readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly detail: string }>;
}

/** gzip of canonical JSON (sorted keys) through CompressionStream. No node:zlib in a service worker. */
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
  /** Truncated upload, hash mismatch, garbage. "Not yet", never fatal. */
  | { readonly kind: 'unreadable'; readonly detail: string }
  | { readonly kind: 'newer-format'; readonly formatVersion: number }
  | { readonly kind: 'unknown-codec'; readonly codec: string };

/** Never throws on bad input. Checks `expected.hash` over the raw bytes before touching the envelope. */
export function open(_bytes: Uint8Array, _codec: Codec, _expected: FileEntry): Promise<Opened> {
  throw new Error('not implemented');
}

/** sha256 (WebCrypto) of bytes, hex. Used for FileEntry.hash. */
export function bytesHash(_bytes: Uint8Array): Promise<string> {
  throw new Error('not implemented');
}
/** sha256 of the canonical plaintext. Stored locally as `pushed[rel]` to skip unchanged publishes. */
export function plaintextHash(_body: Json): Promise<string> {
  throw new Error('not implemented');
}

// ---------- Bodies ----------

export type StateFile<R extends Rec> = {
  readonly device: DeviceId;
  readonly type: string;
  readonly typeVersion: number;
  /** Monotonic per device and type. Lower than already seen = cloud rollback, skipped (could resurrect collected tombstones). */
  readonly seq: number;
  readonly writtenAt: Hlc;
  readonly acked: Acked;
  /** The device's full merged state, not a delta. */
  readonly replica: Replica<R>;
};

export type ShardFile<E extends Ev> = {
  readonly device: DeviceId;
  readonly type: string;
  readonly typeVersion: number;
  readonly shard: ShardId;
  /** This author's events of that day only, sorted by t then key. Rewritten whole when the day gains visits. */
  readonly events: readonly E[];
};

export function encodeStateFile<R extends Rec>(_file: StateFile<R>): Json {
  throw new Error('not implemented');
}
export function encodeShardFile<E extends Ev>(_file: ShardFile<E>): Json {
  throw new Error('not implemented');
}

export type Parsed<T> =
  | { readonly kind: 'ok'; readonly file: T }
  | { readonly kind: 'newer-type-version'; readonly version: number }
  /** Includes a body whose `device` or `shard` disagrees with the key it was read from. */
  | { readonly kind: 'invalid'; readonly detail: string };

/** Validates every stamp, id, and register shape, then each record through `type.parseRecord`. Bad entries drop. */
export function parseStateFile<R extends Rec>(
  _body: unknown,
  _type: RegisterType<R>,
  _at: { readonly device: DeviceId; readonly type: string },
): Parsed<StateFile<R>> {
  throw new Error('not implemented');
}

/** Each event through `type.parseEvent`; events outside the shard's day drop. */
export function parseShardFile<E extends Ev>(
  _body: unknown,
  _type: LogType<E>,
  _at: { readonly device: DeviceId; readonly type: string; readonly shard: ShardId },
): Parsed<ShardFile<E>> {
  throw new Error('not implemented');
}
