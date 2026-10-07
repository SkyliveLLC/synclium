// The only module that knows store key names and bytes.
//
// Layout. Every key has exactly one writer, so a dumb sync folder never sees a write-write conflict.
//   devices/<deviceId>/manifest.json                  envelope + body: Manifest. The commit point.
//   devices/<deviceId>/bookmarks.hsync                envelope + body: StateFile (full merged register state)
//   devices/<deviceId>/reading-list.hsync             envelope + body: StateFile
//   devices/<deviceId>/extensions.hsync               envelope + body: SnapshotFile (this device's own list)
//   devices/<deviceId>/history/<yyyy-mm-dd>.hsync     envelope + body: LogShard (this author's visits, one UTC day)
//
// The manifest is the commit point. A device writes its files first and its manifest last. A reader verifies
// every file against the manifest's hash before parsing, so a torn write, an iCloud placeholder, or a
// half-synced Dropbox file reads as "not yet" and the last good copy stands.
//
// Every body is encrypted with the sync key (sync-key.ts). What the folder shows in the clear: device ids,
// which files exist (so which UTC days have history), their sizes, and when they change. The manifest is
// sealed too, so device names, the file list, and lastSeen are not.
//
// `.hsync`, not `.json.gz`: the bytes are a plaintext header line plus an encrypted gzip body.
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
  type SnapshotType,
} from './model.ts';
import { entryWith, type Acked } from './crdt.ts';

export type StoreKey = Brand<string, 'StoreKey'>;
/** A file name relative to `devices/<id>/`. Minted only by `fileRel`, `shardRel`, and `parseRel`. */
export type RelName = Brand<string, 'RelName'>;

export const DEVICES_PREFIX = 'devices/';
/** The folder setup creates inside the chosen folder or WebDAV collection when it is not already a store. */
export const STORE_NAME = 'Helium Sync';
const MANIFEST_NAME = 'manifest.json';
const EXT = '.hsync';
const TYPE_NAME = '[a-z][a-z0-9-]*';
const REGISTER_REL = new RegExp(`^(${TYPE_NAME})\\${EXT}$`);
const SHARD_REL = new RegExp(`^(${TYPE_NAME})/(\\d{4}-\\d{2}-\\d{2})\\${EXT}$`);


export const keys = {
  manifest: (device: DeviceId): StoreKey => `${DEVICES_PREFIX}${device}/${MANIFEST_NAME}` as StoreKey,
  file: (device: DeviceId, rel: RelName): StoreKey => `${DEVICES_PREFIX}${device}/${rel}` as StoreKey,
};

/** A register or snapshot type's one file. */
export function fileRel(type: { readonly name: string }): RelName {
  return `${type.name}${EXT}` as RelName;
}
export function shardRel(type: LogType<Ev>, day: DayKey): RelName {
  return `${type.name}/${day}${EXT}` as RelName;
}

/** Strict. Anything else in a peer's manifest is dropped as foreign and never fetched. */
export type ParsedRel =
  | { readonly kind: 'file'; readonly type: string; readonly rel: RelName }
  | { readonly kind: 'shard'; readonly type: string; readonly day: DayKey; readonly rel: RelName };

export function parseRel(name: string): ParsedRel | null {
  const register = REGISTER_REL.exec(name);
  if (register?.[1] !== undefined) return { kind: 'file', type: register[1], rel: name as RelName };
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

/** The manifest as a body. `sealManifest` is what goes in the store. */
export function encodeManifest(m: Manifest): Json {
  const files: { [rel: string]: Json } = {};
  for (const [rel, entry] of m.files) files[rel] = { hash: entry.hash, bytes: entry.bytes };
  return {
      formatVersion: m.formatVersion,
      device: m.device,
      name: m.name,
      platform: m.platform,
      app: { name: m.app.name, version: m.app.version },
      seq: m.seq,
      lastSeen: m.lastSeen,
      files,
  };
}

/** Null when malformed or when its `device` disagrees with the folder it sits in. Foreign rels are dropped. */
export function parseManifest(raw: unknown, at: DeviceId): Manifest | null {
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

export async function sealManifest(m: Manifest, cipher: Cipher): Promise<Uint8Array> {
  return (await seal(encodeManifest(m), cipher, keys.manifest(m.device))).bytes;
}

/** A manifest has no manifest above it, so nothing vouches for its hash: the GCM tag alone says it is whole. */
export type ManifestOpened = { readonly kind: 'ok'; readonly manifest: Manifest } | Exclude<Opened, { readonly kind: 'ok' }>;

export async function openManifest(bytes: Uint8Array, at: DeviceId, cipher: Cipher): Promise<ManifestOpened> {
  const opened = await open(bytes, cipher, keys.manifest(at), null);
  if (opened.kind !== 'ok') return opened;
  const manifest = parseManifest(opened.body, at);
  return manifest === null ? { kind: 'not-yet', detail: 'bad manifest' } : { kind: 'ok', manifest };
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(fromUtf8.decode(bytes));
  } catch {
    return undefined;
  }
}

// ---------- Envelope ----------
//   {"codec":"a256gcm-gzip-json","formatVersion":2,"key":"<keyId>","magic":"helium-sync"}\n<iv ‖ ciphertext ‖ tag>
// The plaintext is gzip(canonical JSON). The header stays readable, so a reader can tell another key or a newer
// format from damage before decrypting. The header and the file's store key are the GCM associated data: a
// reader opens bytes only at the path they were sealed for, under the header they were sealed with.

export const FORMAT_VERSION = 2;
const MAGIC = 'helium-sync';
const CODEC = 'a256gcm-gzip-json';

/** Seals and opens bodies. sync-key.ts `cipherFor` builds the only one; nothing in the store is plaintext. */
export interface Cipher {
  /** A non-secret fingerprint of the key, in every header. */
  readonly keyId: string;
  seal(plain: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;
  /** Null when the tag does not verify: wrong key, tampered, torn, or moved from another path. */
  open(sealed: Uint8Array, aad: Uint8Array): Promise<Uint8Array | null>;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = await new Response(new Blob([new Uint8Array(bytes)]).stream().pipeThrough(stream)).arrayBuffer();
  return new Uint8Array(out);
}

function associated(header: Uint8Array, at: StoreKey): Uint8Array {
  const path = utf8.encode(at);
  const aad = new Uint8Array(header.length + path.length);
  aad.set(header, 0);
  aad.set(path, header.length);
  return aad;
}

/** The sealed bytes for `at`, and the manifest entry that vouches for them. */
export async function seal(body: Json, cipher: Cipher, at: StoreKey): Promise<{ readonly bytes: Uint8Array; readonly entry: FileEntry }> {
  const header = utf8.encode(`${canonicalJson({ magic: MAGIC, formatVersion: FORMAT_VERSION, codec: CODEC, key: cipher.keyId })}\n`);
  const plain = await pipe(utf8.encode(canonicalJson(body)), new CompressionStream('gzip'));
  const sealed = await cipher.seal(plain, associated(header, at));
  const bytes = new Uint8Array(header.length + sealed.length);
  bytes.set(header, 0);
  bytes.set(sealed, header.length);
  return { bytes, entry: { hash: await sha256(bytes), bytes: bytes.length } };
}

export type Opened =
  | { readonly kind: 'ok'; readonly body: unknown }
  /** Hash mismatch (torn, placeholder, half-synced), a tag that fails, or garbage. Means "not yet", never "deleted". */
  | { readonly kind: 'not-yet'; readonly detail: string }
  | { readonly kind: 'newer-format'; readonly formatVersion: number }
  | { readonly kind: 'unknown-codec'; readonly codec: string }
  /** Sealed with a different sync key: another sync group shares the folder. */
  | { readonly kind: 'other-key' };

/**
 * Never throws on bad input. With `expected`, checks size and hash over the raw bytes before reading the header.
 * `at` must be the key the bytes were read from.
 */
export async function open(bytes: Uint8Array, cipher: Cipher, at: StoreKey, expected: FileEntry | null): Promise<Opened> {
  if (expected !== null) {
    if (bytes.length !== expected.bytes) return { kind: 'not-yet', detail: `${bytes.length} bytes, manifest says ${expected.bytes}` };
    if ((await sha256(bytes)) !== expected.hash) return { kind: 'not-yet', detail: 'hash mismatch' };
  }
  const newline = bytes.indexOf(0x0a);
  if (newline < 0) return { kind: 'not-yet', detail: 'no header' };
  const header = parseJson(bytes.subarray(0, newline));
  if (!isRecord(header) || header['magic'] !== MAGIC) return { kind: 'not-yet', detail: 'bad header' };
  const { formatVersion, codec, key } = header;
  if (!isCount(formatVersion)) return { kind: 'not-yet', detail: 'bad header' };
  if (formatVersion > FORMAT_VERSION) return { kind: 'newer-format', formatVersion };
  if (typeof codec !== 'string') return { kind: 'not-yet', detail: 'bad header' };
  if (codec !== CODEC) return { kind: 'unknown-codec', codec };
  if (key !== cipher.keyId) return { kind: 'other-key' };
  const plain = await cipher.open(bytes.subarray(newline + 1), associated(bytes.subarray(0, newline + 1), at));
  if (plain === null) return { kind: 'not-yet', detail: 'does not verify' };
  try {
    return { kind: 'ok', body: JSON.parse(fromUtf8.decode(await pipe(plain, new DecompressionStream('gzip')))) };
  } catch (error) {
    return { kind: 'not-yet', detail: String(error) };
  }
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

// ---------- Snapshot body ----------

export type SnapshotFile<S extends Json> = {
  readonly device: DeviceId;
  readonly type: string;
  readonly typeVersion: number;
  readonly content: S;
};

export function encodeSnapshotFile<S extends Json>(file: SnapshotFile<S>): Json {
  return { device: file.device, type: file.type, typeVersion: file.typeVersion, content: file.content };
}

export function parseSnapshotFile<S extends Json>(body: unknown, type: SnapshotType<S>, at: { readonly device: DeviceId }): Parsed<SnapshotFile<S>> {
  const header = parseHeader(body, type, at.device);
  if (header.kind !== 'ok') return header;
  const typeVersion = header.file['typeVersion'];
  const content = type.parseContent(header.file['content']);
  if (!isCount(typeVersion) || content === null) return { kind: 'invalid', detail: 'bad snapshot' };
  return { kind: 'ok', file: { device: at.device, type: type.name, typeVersion, content } };
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

