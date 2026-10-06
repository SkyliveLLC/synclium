// The only module that knows store key names and bytes. Round 1's envelope and StateFile are kept. Round 1's
// meta.json grew a file index and became the manifest (from candidate 2), and log shards are new.
//
// Layout. Every key has exactly one writer, so a dumb sync folder never sees a write-write conflict.
//   devices/<deviceId>/manifest.json                  Manifest, plain JSON. The commit point.
//   devices/<deviceId>/bookmarks.hsync                envelope + body: StateFile (full merged register state)
//   devices/<deviceId>/history/<yyyy-mm-dd>.hsync     envelope + body: LogShard (this author's visits, one UTC day)
//
// The manifest is the commit point. A device writes its files first and its manifest last. A reader verifies
// every file against the manifest's hash before parsing, so a torn write, an iCloud placeholder, or a
// half-synced Dropbox file reads as "not yet" and the last good copy stands.
//
// `.hsync`, not `.json.gz`: the bytes are a plaintext header line plus a gzip body, which no gzip tool opens.
// Candidate 1 also suspected Chromium's download protection fires on archive extensions when a File System
// Access writer closes. That reason is unverified.
import type { Brand, DayKey, DeviceId, Ev, Hlc, Json, LogType, Rec, RegisterType, Replica } from './model.ts';
import type { Acked } from './crdt.ts';

export type StoreKey = Brand<string, 'StoreKey'>;
/** A file name relative to `devices/<id>/`. Minted only by `registerRel`, `shardRel`, and `parseRel`. */
export type RelName = Brand<string, 'RelName'>;

export const DEVICES_PREFIX = 'devices/';

export const keys = {
  manifest: (_device: DeviceId): StoreKey => {
    throw new Error('not implemented');
  },
  file: (_device: DeviceId, _rel: RelName): StoreKey => {
    throw new Error('not implemented');
  },
};

export function registerRel(_type: RegisterType<Rec>): RelName {
  throw new Error('not implemented');
}
export function shardRel(_type: LogType<Ev>, _day: DayKey): RelName {
  throw new Error('not implemented');
}

/** Strict. Anything else in a peer's manifest is dropped as foreign and never fetched. */
export type ParsedRel =
  | { readonly kind: 'register'; readonly type: string; readonly rel: RelName }
  | { readonly kind: 'shard'; readonly type: string; readonly day: DayKey; readonly rel: RelName };
export function parseRel(_name: string): ParsedRel | null {
  throw new Error('not implemented');
}

// ---------- Manifest ----------

/** chrome.runtime.getPlatformInfo().os, narrowed to what Helium ships on. */
export type Platform = 'mac' | 'win' | 'linux';
export function parsePlatform(_os: string): Platform {
  throw new Error('not implemented');
}

/** sha256 of the sealed bytes, hex. What a reader checks before it parses. */
export type FileEntry = { readonly hash: string; readonly bytes: number };

export type Manifest = {
  readonly formatVersion: typeof FORMAT_VERSION;
  readonly device: DeviceId;
  /** Typed by the user at setup. The extension cannot read the hostname. */
  readonly name: string;
  readonly platform: Platform;
  readonly app: { readonly name: 'helium-sync'; readonly version: string };
  /**
   * Monotonic per device. Lower than already seen from a peer = cloud rollback, so the last good manifest
   * stands. Higher than we wrote in our own = another install writes our DeviceId (identity clash).
   */
  readonly seq: number;
  /** Wall ms, rewritten at least every heartbeat. Drives idle detection, so clock skew shifts it (accepted). */
  readonly lastSeen: number;
  /** Every file this device publishes now. Absent means deleted: an expired shard, or a type turned off. */
  readonly files: ReadonlyMap<RelName, FileEntry>;
};

/** Plain JSON on purpose: it holds no profile data, and the setup preview lists peers without a codec. */
export function encodeManifest(_m: Manifest): Uint8Array {
  throw new Error('not implemented');
}
/** Null when malformed or when its `device` disagrees with the folder it sits in. Foreign rels are dropped. */
export function parseManifest(_bytes: Uint8Array, _at: DeviceId): Manifest | null {
  throw new Error('not implemented');
}

// ---------- Envelope and codec (round 1) ----------
//   {"magic":"helium-sync","formatVersion":1,"codec":"gzip-json"}\n<body bytes>
// The header stays plaintext under every codec, so encryption later is a new CodecId plus pairing.

export const FORMAT_VERSION = 1;
export type CodecId = 'gzip-json';

export interface Codec {
  readonly id: CodecId;
  encode(body: Json): Promise<Uint8Array>;
  decode(bytes: Uint8Array): Promise<{ readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly detail: string }>;
}

/** Canonical JSON (sorted keys) through CompressionStream('gzip'). Runs in the service worker and in Node 24. */
export const gzipJson: Codec = {
  id: 'gzip-json',
  encode: () => {
    throw new Error('not implemented');
  },
  decode: () => {
    throw new Error('not implemented');
  },
};

/** The sealed bytes and the manifest entry that vouches for them. */
export function seal(_body: Json, _codec: Codec): Promise<{ readonly bytes: Uint8Array; readonly entry: FileEntry }> {
  throw new Error('not implemented');
}

export type Opened =
  | { readonly kind: 'ok'; readonly body: unknown }
  /** Hash mismatch (torn, placeholder, half-synced) or garbage. Means "not yet", never "deleted". */
  | { readonly kind: 'not-yet'; readonly detail: string }
  | { readonly kind: 'newer-format'; readonly formatVersion: number }
  | { readonly kind: 'unknown-codec'; readonly codec: string };

/** Never throws on bad input. Checks `expected.hash` over the raw bytes before it reads the header. */
export function open(_bytes: Uint8Array, _codec: Codec, _expected: FileEntry): Promise<Opened> {
  throw new Error('not implemented');
}

/** sha256 of the canonical plaintext. Kept locally per published file to skip re-sealing unchanged content. */
export function plaintextHash(_body: Json): Promise<string> {
  throw new Error('not implemented');
}

// ---------- Register body (round 1 StateFile, unchanged) ----------

export type StateFile<R extends Rec> = {
  readonly device: DeviceId;
  readonly type: string;
  readonly typeVersion: number;
  /** Monotonic. Lower than already seen from a peer = cloud rollback. */
  readonly seq: number;
  readonly writtenAt: Hlc;
  readonly acked: Acked;
  readonly replica: Replica<R>;
};

export function encodeStateFile<R extends Rec>(_file: StateFile<R>): Json {
  throw new Error('not implemented');
}

export type Parsed<T> =
  | { readonly kind: 'ok'; readonly file: T }
  | { readonly kind: 'newer-type-version'; readonly version: number }
  /** Includes a body whose `device`, `type`, or `day` disagrees with the key it was read from. */
  | { readonly kind: 'invalid'; readonly detail: string };

export function parseStateFile<R extends Rec>(
  _body: unknown,
  _type: RegisterType<R>,
  _at: { readonly device: DeviceId },
): Parsed<StateFile<R>> {
  throw new Error('not implemented');
}

// ---------- Log body (new) ----------

/** One author's events for one UTC day, sorted by `t` then key. Rewritten whole when the day changes. */
export type LogShard<E extends Ev> = {
  readonly device: DeviceId;
  readonly type: string;
  readonly typeVersion: number;
  readonly day: DayKey;
  readonly events: readonly E[];
};

export function encodeLogShard<E extends Ev>(_shard: LogShard<E>): Json {
  throw new Error('not implemented');
}

/** Each event through `type.parseEvent`. Bad events and events outside `day` drop, never the whole shard. */
export function parseLogShard<E extends Ev>(
  _body: unknown,
  _type: LogType<E>,
  _at: { readonly device: DeviceId; readonly day: DayKey },
): Parsed<LogShard<E>> {
  throw new Error('not implemented');
}
