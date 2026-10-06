// The only module that knows store key names and bytes.
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
import {
  dayRange,
  isDayKey,
  isDeviceId,
  isHlc,
  isItemId,
  type Brand,
  type DayKey,
  type DeviceId,
  type Entry,
  type Ev,
  type Hlc,
  type ItemId,
  type Json,
  type LogType,
  type Rec,
  type Reg,
  type RegisterType,
  type Replica,
} from './model.ts';
import { entryWith, type Acked } from './crdt.ts';

export type StoreKey = Brand<string, 'StoreKey'>;
/** A file name relative to `devices/<id>/`. Minted only by `registerRel`, `shardRel`, and `parseRel`. */
export type RelName = Brand<string, 'RelName'>;

export const DEVICES_PREFIX = 'devices/';
const MANIFEST_NAME = 'manifest.json';
const EXT = '.hsync';
const TYPE_NAME = '[a-z][a-z0-9-]*';
const REGISTER_REL = new RegExp(`^(${TYPE_NAME})\\${EXT}$`);
const SHARD_REL = new RegExp(`^(${TYPE_NAME})/(\\d{4}-\\d{2}-\\d{2})\\${EXT}$`);


export const keys = {
  manifest: (device: DeviceId): StoreKey => `${DEVICES_PREFIX}${device}/${MANIFEST_NAME}` as StoreKey,
  file: (device: DeviceId, rel: RelName): StoreKey => `${DEVICES_PREFIX}${device}/${rel}` as StoreKey,
};

export function registerRel(type: RegisterType<Rec>): RelName {
  return `${type.name}${EXT}` as RelName;
}
export function shardRel(type: LogType<Ev>, day: DayKey): RelName {
  return `${type.name}/${day}${EXT}` as RelName;
}

/** Strict. Anything else in a peer's manifest is dropped as foreign and never fetched. */
export type ParsedRel =
  | { readonly kind: 'register'; readonly type: string; readonly rel: RelName }
  | { readonly kind: 'shard'; readonly type: string; readonly day: DayKey; readonly rel: RelName };

export function parseRel(name: string): ParsedRel | null {
  const register = REGISTER_REL.exec(name);
  if (register?.[1] !== undefined) return { kind: 'register', type: register[1], rel: name as RelName };
  const shard = SHARD_REL.exec(name);
  if (shard?.[1] !== undefined && shard[2] !== undefined && isDayKey(shard[2])) return { kind: 'shard', type: shard[1], day: shard[2], rel: name as RelName };
  return null;
}

/** Inverse of `keys.file`, for the peer-day marks LogLocal keeps by store key. */
export function parseKey(key: StoreKey): { readonly device: DeviceId; readonly rel: ParsedRel } | null {
  if (!key.startsWith(DEVICES_PREFIX)) return null;
  const slash = key.indexOf('/', DEVICES_PREFIX.length);
  if (slash < 0) return null;
  const device = key.slice(DEVICES_PREFIX.length, slash);
  const rel = parseRel(key.slice(slash + 1));
  return isDeviceId(device) && rel !== null ? { device, rel } : null;
}

// ---------- Canonical JSON and hashing ----------

/** Sorted keys, so equal content hashes equal on every device. */
export function canonicalJson(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (isJsonArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k] ?? null)}`)
    .join(',')}}`;
}

const isJsonArray = (v: Json): v is readonly Json[] => Array.isArray(v);

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** sha256 of the canonical plaintext. Kept locally per published file to skip re-sealing unchanged content. */
export function plaintextHash(body: Json): Promise<string> {
  return sha256(utf8.encode(canonicalJson(body)));
}

// ---------- Manifest ----------

/** chrome.runtime.getPlatformInfo().os, narrowed to what Helium ships on. */
export type Platform = 'mac' | 'win' | 'linux';
const PLATFORMS: readonly Platform[] = ['mac', 'win', 'linux'];
const isPlatform = (s: string): s is Platform => PLATFORMS.some((p) => p === s);
export function parsePlatform(os: string): Platform {
  return isPlatform(os) ? os : 'linux';
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

const isRecord = (v: unknown): v is { readonly [k: string]: unknown } => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const HEX64 = /^[0-9a-f]{64}$/;

function parseFileEntry(raw: unknown): FileEntry | null {
  if (!isRecord(raw)) return null;
  const { hash, bytes } = raw;
  return typeof hash === 'string' && HEX64.test(hash) && isCount(bytes) ? { hash, bytes } : null;
}

/** Plain JSON on purpose: it holds no profile data, and the setup preview lists peers without a codec. */
export function encodeManifest(m: Manifest): Uint8Array {
  const files: { [rel: string]: Json } = {};
  for (const [rel, entry] of m.files) files[rel] = { hash: entry.hash, bytes: entry.bytes };
  return utf8.encode(
    canonicalJson({
      formatVersion: m.formatVersion,
      device: m.device,
      name: m.name,
      platform: m.platform,
      app: { name: m.app.name, version: m.app.version },
      seq: m.seq,
      lastSeen: m.lastSeen,
      files,
    }),
  );
}

/** Null when malformed or when its `device` disagrees with the folder it sits in. Foreign rels are dropped. */
export function parseManifest(bytes: Uint8Array, at: DeviceId): Manifest | null {
  const raw = parseJson(bytes);
  if (!isRecord(raw) || raw['formatVersion'] !== FORMAT_VERSION || raw['device'] !== at) return null;
  const { name, platform, app, seq, lastSeen, files } = raw;
  if (typeof name !== 'string' || typeof platform !== 'string' || !isPlatform(platform)) return null;
  if (!isRecord(app) || app['name'] !== 'helium-sync' || typeof app['version'] !== 'string') return null;
  if (!isCount(seq) || typeof lastSeen !== 'number' || !Number.isFinite(lastSeen) || !isRecord(files)) return null;
  const parsedFiles = new Map<RelName, FileEntry>();
  for (const [rel, entry] of Object.entries(files)) {
    const parsed = parseRel(rel);
    const fileEntry = parseFileEntry(entry);
    if (parsed !== null && fileEntry !== null) parsedFiles.set(parsed.rel, fileEntry);
  }
  return { formatVersion: FORMAT_VERSION, device: at, name, platform, app: { name: 'helium-sync', version: app['version'] }, seq, lastSeen, files: parsedFiles };
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(fromUtf8.decode(bytes));
  } catch {
    return undefined;
  }
}

// ---------- Envelope and codec ----------
//   {"magic":"helium-sync","formatVersion":1,"codec":"gzip-json"}\n<body bytes>
// The header stays plaintext under every codec, so encryption later is a new CodecId plus pairing.

export const FORMAT_VERSION = 1;
const MAGIC = 'helium-sync';
export type CodecId = 'gzip-json';

export interface Codec {
  readonly id: CodecId;
  encode(body: Json): Promise<Uint8Array>;
  decode(bytes: Uint8Array): Promise<{ readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly detail: string }>;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = await new Response(new Blob([new Uint8Array(bytes)]).stream().pipeThrough(stream)).arrayBuffer();
  return new Uint8Array(out);
}

/** Canonical JSON (sorted keys) through CompressionStream('gzip'). Runs in the service worker and in Node 24. */
export const gzipJson: Codec = {
  id: 'gzip-json',
  encode: (body) => pipe(utf8.encode(canonicalJson(body)), new CompressionStream('gzip')),
  decode: async (bytes) => {
    try {
      const plain = await pipe(bytes, new DecompressionStream('gzip'));
      return { ok: true, body: JSON.parse(fromUtf8.decode(plain)) };
    } catch (error) {
      return { ok: false, detail: String(error) };
    }
  },
};

/** The sealed bytes and the manifest entry that vouches for them. */
export async function seal(body: Json, codec: Codec): Promise<{ readonly bytes: Uint8Array; readonly entry: FileEntry }> {
  const header = utf8.encode(`${JSON.stringify({ magic: MAGIC, formatVersion: FORMAT_VERSION, codec: codec.id })}\n`);
  const encoded = await codec.encode(body);
  const bytes = new Uint8Array(header.length + encoded.length);
  bytes.set(header, 0);
  bytes.set(encoded, header.length);
  return { bytes, entry: { hash: await sha256(bytes), bytes: bytes.length } };
}

export type Opened =
  | { readonly kind: 'ok'; readonly body: unknown }
  /** Hash mismatch (torn, placeholder, half-synced) or garbage. Means "not yet", never "deleted". */
  | { readonly kind: 'not-yet'; readonly detail: string }
  | { readonly kind: 'newer-format'; readonly formatVersion: number }
  | { readonly kind: 'unknown-codec'; readonly codec: string };

/** Never throws on bad input. Checks `expected.hash` over the raw bytes before it reads the header. */
export async function open(bytes: Uint8Array, codec: Codec, expected: FileEntry): Promise<Opened> {
  if (bytes.length !== expected.bytes) return { kind: 'not-yet', detail: `${bytes.length} bytes, manifest says ${expected.bytes}` };
  if ((await sha256(bytes)) !== expected.hash) return { kind: 'not-yet', detail: 'hash mismatch' };
  const newline = bytes.indexOf(0x0a);
  if (newline < 0) return { kind: 'not-yet', detail: 'no header' };
  const header = parseJson(bytes.subarray(0, newline));
  if (!isRecord(header) || header['magic'] !== MAGIC) return { kind: 'not-yet', detail: 'bad header' };
  const { formatVersion, codec: codecId } = header;
  if (!isCount(formatVersion)) return { kind: 'not-yet', detail: 'bad header' };
  if (formatVersion > FORMAT_VERSION) return { kind: 'newer-format', formatVersion };
  if (typeof codecId !== 'string') return { kind: 'not-yet', detail: 'bad header' };
  if (codecId !== codec.id) return { kind: 'unknown-codec', codec: codecId };
  const decoded = await codec.decode(bytes.subarray(newline + 1));
  return decoded.ok ? { kind: 'ok', body: decoded.body } : { kind: 'not-yet', detail: decoded.detail };
}

// ---------- Register body (StateFile) ----------

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

/** The part of a state file that changes only when content does. What `plain` hashes. */
export function encodeRegisterContent<R extends Rec>(content: { readonly acked: Acked; readonly replica: Replica<R> }): Json {
  const acked: { [device: string]: Json } = {};
  for (const [device, stamp] of content.acked) acked[device] = stamp;
  const replica: { [id: string]: Json } = {};
  for (const [id, entry] of content.replica) {
    const fields: { [field: string]: Json } = {};
    const view: { readonly fields: { readonly [field: string]: Reg<unknown> } } = entry;
    for (const [field, [value, stamp]] of Object.entries(view.fields)) fields[field] = [toJson(value), stamp];
    replica[id] = { kind: entry.kind, fields, deleted: [entry.deleted[0], entry.deleted[1]] };
  }
  return { acked, replica };
}

/** Record field values are JSON by construction (they came from `parseRecord` or the profile). */
function toJson(value: unknown): Json {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(toJson);
  if (isRecord(value)) {
    const out: { [k: string]: Json } = {};
    for (const [k, v] of Object.entries(value)) out[k] = toJson(v);
    return out;
  }
  throw new Error(`not json: ${typeof value}`);
}

export function encodeStateFile<R extends Rec>(file: StateFile<R>): Json {
  const content = encodeRegisterContent(file);
  if (!isRecord(content)) throw new Error('unreachable');
  return { ...content, device: file.device, type: file.type, typeVersion: file.typeVersion, seq: file.seq, writtenAt: file.writtenAt };
}

export type Parsed<T> =
  | { readonly kind: 'ok'; readonly file: T }
  | { readonly kind: 'newer-type-version'; readonly version: number }
  /** Includes a body whose `device`, `type`, or `day` disagrees with the key it was read from. */
  | { readonly kind: 'invalid'; readonly detail: string };

const isReg = (v: unknown): v is readonly [unknown, Hlc] => Array.isArray(v) && v.length === 2 && typeof v[1] === 'string' && isHlc(v[1]);

function parseEntry<R extends Rec>(raw: unknown, type: RegisterType<R>): Entry<R> | null {
  if (!isRecord(raw) || !isRecord(raw['fields']) || !isReg(raw['deleted']) || typeof raw['deleted'][0] !== 'boolean') return null;
  const stamps = new Map<string, Hlc>();
  const values: { [field: string]: unknown } = {};
  for (const [field, reg] of Object.entries(raw['fields'])) {
    if (!isReg(reg)) return null;
    values[field] = reg[0];
    stamps.set(field, reg[1]);
  }
  const record = type.parseRecord({ ...values, kind: raw['kind'] });
  if (record === null) return null;
  for (const field of Object.keys(record)) if (field !== 'kind' && !stamps.has(field)) return null;
  const [deleted, deletedAt] = raw['deleted'];
  return entryWith(record, (field) => stamps.get(field) ?? deletedAt, [deleted, deletedAt]);
}

function parseHeader(body: unknown, type: { readonly name: string; readonly version: number }, device: DeviceId): Parsed<{ readonly [k: string]: unknown }> {
  if (!isRecord(body)) return { kind: 'invalid', detail: 'not an object' };
  if (body['device'] !== device) return { kind: 'invalid', detail: 'device disagrees with its folder' };
  if (body['type'] !== type.name) return { kind: 'invalid', detail: 'type disagrees with its name' };
  const version = body['typeVersion'];
  if (!isCount(version)) return { kind: 'invalid', detail: 'bad typeVersion' };
  if (version > type.version) return { kind: 'newer-type-version', version };
  return { kind: 'ok', file: body };
}

export function parseStateFile<R extends Rec>(body: unknown, type: RegisterType<R>, at: { readonly device: DeviceId }): Parsed<StateFile<R>> {
  const header = parseHeader(body, type, at.device);
  if (header.kind !== 'ok') return header;
  const raw = header.file;
  const { seq, writtenAt, acked, replica } = raw;
  if (!isCount(seq) || typeof writtenAt !== 'string' || !isHlc(writtenAt) || !isRecord(acked) || !isRecord(replica)) return { kind: 'invalid', detail: 'bad state file' };
  const parsedAcked = new Map<DeviceId, Hlc>();
  for (const [device, stamp] of Object.entries(acked)) {
    if (!isDeviceId(device) || typeof stamp !== 'string' || !isHlc(stamp)) return { kind: 'invalid', detail: 'bad acked' };
    parsedAcked.set(device, stamp);
  }
  const parsedReplica = new Map<ItemId, Entry<R>>();
  for (const [id, rawEntry] of Object.entries(replica)) {
    if (!isItemId(id)) continue;
    const entry = parseEntry(rawEntry, type);
    if (entry !== null) parsedReplica.set(id, entry);
  }
  const typeVersion = raw['typeVersion'];
  if (!isCount(typeVersion)) return { kind: 'invalid', detail: 'bad typeVersion' };
  return { kind: 'ok', file: { device: at.device, type: type.name, typeVersion, seq, writtenAt, acked: parsedAcked, replica: parsedReplica } };
}

// ---------- Log body ----------

/** One author's events for one UTC day, sorted by `t` then key. Rewritten whole when the day changes. */
export type LogShard<E extends Ev> = {
  readonly device: DeviceId;
  readonly type: string;
  readonly typeVersion: number;
  readonly day: DayKey;
  readonly events: readonly E[];
};

export function encodeLogShard<E extends Ev>(shard: LogShard<E>): Json {
  return { device: shard.device, type: shard.type, typeVersion: shard.typeVersion, day: shard.day, events: shard.events.map(toJson) };
}

/** Each event through `type.parseEvent`. Bad events and events outside `day` drop, never the whole shard. */
export function parseLogShard<E extends Ev>(body: unknown, type: LogType<E>, at: { readonly device: DeviceId; readonly day: DayKey }): Parsed<LogShard<E>> {
  const header = parseHeader(body, type, at.device);
  if (header.kind !== 'ok') return header;
  const raw = header.file;
  if (raw['day'] !== at.day) return { kind: 'invalid', detail: 'day disagrees with its name' };
  const rawEvents = raw['events'];
  const typeVersion = raw['typeVersion'];
  if (!Array.isArray(rawEvents) || !isCount(typeVersion)) return { kind: 'invalid', detail: 'bad shard' };
  const [start, end] = dayRange(at.day);
  const events: E[] = [];
  for (const rawEvent of rawEvents) {
    const event = type.parseEvent(rawEvent);
    if (event !== null && event.t >= start && event.t < end) events.push(event);
  }
  return { kind: 'ok', file: { device: at.device, type: type.name, typeVersion, day: at.day, events: sortEvents(events, type) } };
}

export function sortEvents<E extends Ev>(events: readonly E[], type: LogType<E>): E[] {
  return [...events].sort((a, b) => a.t - b.t || (type.key(a) < type.key(b) ? -1 : type.key(a) > type.key(b) ? 1 : 0));
}

