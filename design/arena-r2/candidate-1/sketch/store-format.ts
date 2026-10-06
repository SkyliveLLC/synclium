// The only module that knows store key names and bytes. Round 1's layout, envelope, StateFile, and DeviceMeta
// are kept. Two changes: history shard keys (below), and the codec runs on CompressionStream and
// crypto.subtle instead of node:zlib and node:crypto.
//
// Layout. Every key has exactly one writer, so a dumb sync folder never sees a write-write conflict.
//   devices/<deviceId>/meta.json                 DeviceMeta, plain JSON
//   devices/<deviceId>/bookmarks.hsync           envelope + codec body holding a StateFile (full merged state)
//   devices/<deviceId>/history/<yyyy-mm-dd>.hsync envelope + codec body holding a HistoryShard (own visits, one UTC day)
// `.hsync`, not `.json.gz`: an archive extension can trip Chromium's download-protection check when a
// File System Access writer closes, and an unknown extension does not.
import type { Brand, DataType, DeviceId, Hlc, Json, Rec, Replica } from './model.ts';
import type { Acked } from './crdt.ts';
import type { DayKey, Visit } from './history.ts';

export type StoreKey = Brand<string, 'StoreKey'>;

export const DEVICES_PREFIX = 'devices/';

export const keys = {
  meta: (_device: DeviceId): StoreKey => {
    throw new Error('not implemented');
  },
  bookmarks: (_device: DeviceId): StoreKey => {
    throw new Error('not implemented');
  },
  historyShard: (_device: DeviceId, _day: DayKey): StoreKey => {
    throw new Error('not implemented');
  },
};

/**
 * Strict. Dropbox "(conflicted copy)", Syncthing `.syncthing.*.tmp`, Chromium's `.crswap` writer swap files,
 * `.DS_Store` all return null and surface as foreign files. iCloud placeholders never reach here: the folder
 * store reports them under their real name as not yet downloaded.
 */
export type ParsedKey =
  | { readonly kind: 'meta'; readonly device: DeviceId; readonly key: StoreKey }
  | { readonly kind: 'bookmarks'; readonly device: DeviceId; readonly key: StoreKey }
  | { readonly kind: 'history'; readonly device: DeviceId; readonly day: DayKey; readonly key: StoreKey };
export function parseKey(_name: string): ParsedKey | null {
  throw new Error('not implemented');
}

// ---------- Envelope and codec (round 1) ----------
//   {"magic":"helium-sync","formatVersion":1,"codec":"gzip-json"}\n<body bytes>
// The header stays plaintext under every codec, so encryption later is a new CodecId plus pairing.

export const FORMAT_VERSION = 1;
export type CodecId = 'gzip-json';
export type Envelope = { readonly magic: 'helium-sync'; readonly formatVersion: typeof FORMAT_VERSION; readonly codec: CodecId };

export interface Codec {
  readonly id: CodecId;
  encode(body: Json): Promise<Uint8Array>;
  decode(bytes: Uint8Array): Promise<{ readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly detail: string }>;
}

/** Canonical JSON (sorted keys) through CompressionStream('gzip'). Works in the service worker and in Node 24. */
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
  | { readonly kind: 'unreadable'; readonly detail: string }
  | { readonly kind: 'newer-format'; readonly formatVersion: number }
  | { readonly kind: 'unknown-codec'; readonly codec: string };

/** Never throws on bad input. */
export function open(_bytes: Uint8Array, _codec: Codec): Promise<Opened> {
  throw new Error('not implemented');
}

/** sha256 (crypto.subtle) of the canonical plaintext. Stored locally as `pushedHash` to skip unchanged publishes. */
export function plaintextHash(_body: Json): Promise<string> {
  throw new Error('not implemented');
}

// ---------- Bookmarks body (round 1 StateFile, unchanged) ----------

export type StateFile<R extends Rec> = {
  readonly device: DeviceId;
  readonly type: string;
  readonly typeVersion: number;
  /** Monotonic. Lower than already seen from a peer = cloud rollback. Higher than ours = identity clash. */
  readonly seq: number;
  readonly writtenAt: Hlc;
  readonly acked: Acked;
  readonly replica: Replica<R>;
};

export function encodeStateFile<R extends Rec>(_file: StateFile<R>): Json {
  throw new Error('not implemented');
}

export type ParsedState<R extends Rec> =
  | { readonly kind: 'ok'; readonly file: StateFile<R> }
  | { readonly kind: 'newer-type-version'; readonly version: number }
  | { readonly kind: 'invalid'; readonly detail: string };

export function parseStateFile<R extends Rec>(
  _body: unknown,
  _type: DataType<R>,
  _at: { readonly device: DeviceId; readonly type: string },
): ParsedState<R> {
  throw new Error('not implemented');
}

// ---------- History body (new) ----------

/**
 * One device's own visits for one UTC day. Not merged state: a device publishes only what it visited, so
 * the union over devices is the history and no file ever holds another device's visits.
 */
export type HistoryShard = {
  readonly device: DeviceId;
  readonly day: DayKey;
  /** Monotonic per (device, day). A lower rev than already indexed is a cloud rollback and is ignored. */
  readonly rev: number;
  readonly visits: readonly Visit[];
};

export function encodeShard(_shard: HistoryShard): Json {
  throw new Error('not implemented');
}
/** Drops malformed visits and non-http(s) urls, never the whole shard. Null when the body disagrees with its key. */
export function parseShard(_body: unknown, _at: { readonly device: DeviceId; readonly day: DayKey }): HistoryShard | null {
  throw new Error('not implemented');
}

// ---------- Presence ----------

/** chrome.runtime.getPlatformInfo().os, narrowed to what Helium ships on. */
export type Platform = 'mac' | 'win' | 'linux';
export function parsePlatform(_os: string): Platform {
  throw new Error('not implemented');
}

export type DeviceMeta = {
  readonly formatVersion: typeof FORMAT_VERSION;
  readonly device: DeviceId;
  /** Typed by the user at setup. The extension cannot read the hostname. */
  readonly name: string;
  readonly platform: Platform;
  readonly app: { readonly name: 'helium-sync'; readonly version: string };
  readonly lastSeen: number;
};

export function encodeMeta(_meta: DeviceMeta): Uint8Array {
  throw new Error('not implemented');
}
export function parseMeta(_bytes: Uint8Array, _at: DeviceId): DeviceMeta | null {
  throw new Error('not implemented');
}
