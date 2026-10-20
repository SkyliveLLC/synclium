// The vaults, in one SQLite file (node:sqlite, no npm dependency). The only module that touches SQL, and the only
// mint of VaultId, ObjectKey, and Prefix.
//
// A vault is every object one sync group stores, named by sha256 of the bearer token its sync key derives
// (extension/src/sync-key.ts `vaultTokenFor`). It has no row of its own: usage, emptiness, and last activity are
// derived from the objects, so nothing is kept in step beside them. An unknown vault reads as empty, which is
// what makes a wiped server look like a new one to the devices, and they republish.
//
// Two server processes on one volume (Coolify starts the new container before stopping the old) serialize their
// writes on SQLite's file lock: WAL plus busy_timeout. A put is one BEGIN IMMEDIATE transaction holding the quota
// check and the write, so neither process can overshoot a quota, and a crash leaves the previous version whole.
import { createHash } from 'node:crypto';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { LIMITS, type Quota } from './limits.ts';

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** 64 lowercase hex digits: sha256 of the bearer token. The token itself is never stored. Minted by `vaultOf`. */
export type VaultId = Brand<string, 'VaultId'>;
/** 1-6 segments of [A-Za-z0-9._-]{1,128}, none '.' or '..', at most 512 chars. Minted by `keyOf`. */
export type ObjectKey = Brand<string, 'ObjectKey'>;
/** '' (the vault root) or an ObjectKey plus '/'. Minted by `prefixOf`. */
export type Prefix = Brand<string, 'Prefix'>;

export type Stored = { readonly body: Uint8Array<ArrayBuffer>; readonly etag: string };
export type Usage = { readonly bytes: number; readonly objects: number };

/** `over-quota`: the vault would pass its quota. `no-room`: the put grows the data and growth was refused. */
export type PutResult = 'stored' | 'over-quota' | 'no-room';

export interface Vaults {
  /** Names directly under `prefix`, files and folders alike, sorted and unique. Empty for an unknown vault. */
  list(vault: VaultId, prefix: Prefix): readonly string[];
  get(vault: VaultId, key: ObjectKey): Stored | null;
  /**
   * Insert or replace; a replace counts only its size difference against the quota. With `mayGrow` false (the
   * disk guard tripped), only a put no larger than the object it replaces is stored.
   */
  put(vault: VaultId, key: ObjectKey, body: Uint8Array, etag: string, now: number, mayGrow?: boolean): PutResult;
  /** Absent is success. A folder is only a shared key prefix, so there is none to clean up. */
  delete(vault: VaultId, key: ObjectKey): void;
  usage(vault: VaultId): Usage;
  /** Deletes every vault whose newest write is older than `before` and frees its pages. Returns how many went. Idempotent. */
  purgeIdle(before: number): number;
  /** Throws when the database cannot answer. */
  ping(): void;
  close(): void;
}

const TOKEN = /^Bearer ([A-Za-z0-9_-]{43})$/i;
const SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_SEGMENTS = 6;
const MAX_KEY_CHARS = 512;

/** The vault an `Authorization` header opens, or null when it is not `Bearer <43 base64url chars>`. */
export function vaultOf(authorization: string | null): VaultId | null {
  const token = TOKEN.exec(authorization ?? '')?.[1];
  if (token === undefined) return null;
  return createHash('sha256').update(token).digest('hex') as VaultId;
}

/**
 * `raw` as an ObjectKey, or null. `raw` is a still percent-encoded path: '%' is outside the grammar, so nothing is
 * ever decoded and every key has exactly one spelling.
 */
export function keyOf(raw: string): ObjectKey | null {
  const segments = raw.split('/');
  const ok = raw.length <= MAX_KEY_CHARS && segments.length <= MAX_SEGMENTS && segments.every((s) => SEGMENT.test(s) && s !== '.' && s !== '..');
  return ok ? (raw as ObjectKey) : null;
}

/** `raw` as a Prefix: '' or a key followed by '/'. */
export function prefixOf(raw: string): Prefix | null {
  if (raw === '') return raw as Prefix;
  return raw.endsWith('/') && keyOf(raw.slice(0, -1)) !== null ? (raw as Prefix) : null;
}

// auto_vacuum only takes effect on a new file, so it comes before the first table. busy_timeout comes first of
// all, so a second process opening the file mid-write waits instead of failing.
const SCHEMA = `
  PRAGMA busy_timeout = 5000;
  PRAGMA auto_vacuum = INCREMENTAL;
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS objects (
    vault   TEXT    NOT NULL,
    key     TEXT    NOT NULL,
    etag    TEXT    NOT NULL,
    size    INTEGER NOT NULL,
    updated INTEGER NOT NULL,
    body    BLOB    NOT NULL,
    PRIMARY KEY (vault, key)
  );
  CREATE INDEX IF NOT EXISTS objects_activity ON objects (vault, updated);
`;

type Row = Record<string, SQLOutputValue>;

function numberIn(row: Row | undefined, column: string): number {
  const value = row?.[column];
  if (typeof value !== 'number') throw new Error(`objects.${column} is not a number`);
  return value;
}

function stringIn(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new Error(`objects.${column} is not text`);
  return value;
}

/** Opens the database at `path`, creating it if needed; ':memory:' for tests. */
export function openVaults(path: string, quota: Quota = LIMITS.vault): Vaults {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  // Keys are ASCII from the grammar, all below '~', so [prefix, prefix + '~') is exactly the keys under `prefix`
  // and the primary key index serves the range. A vault holds at most quota.objects rows: no paging.
  const listQ = db.prepare('SELECT key FROM objects WHERE vault = ? AND key >= ? AND key < ? ORDER BY key');
  const getQ = db.prepare('SELECT body, etag FROM objects WHERE vault = ? AND key = ?');
  const sizeQ = db.prepare('SELECT size FROM objects WHERE vault = ? AND key = ?');
  const usageQ = db.prepare('SELECT TOTAL(size) AS bytes, COUNT(*) AS objects FROM objects WHERE vault = ?');
  const upsertQ = db.prepare(`
    INSERT INTO objects (vault, key, etag, size, updated, body) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (vault, key) DO UPDATE SET etag = excluded.etag, size = excluded.size, updated = excluded.updated, body = excluded.body
  `);
  const deleteQ = db.prepare('DELETE FROM objects WHERE vault = ? AND key = ?');
  const purgeQ = db.prepare(`
    DELETE FROM objects WHERE vault IN (SELECT vault FROM objects GROUP BY vault HAVING MAX(updated) < ?)
    RETURNING vault
  `);
  const pingQ = db.prepare('SELECT 1 AS one');

  const usage = (vault: VaultId): Usage => {
    const row = usageQ.get(vault);
    return { bytes: numberIn(row, 'bytes'), objects: numberIn(row, 'objects') };
  };

  return {
    list(vault, prefix) {
      const names = new Set<string>();
      for (const row of listQ.all(vault, prefix, `${prefix}~`)) {
        const rest = stringIn(row, 'key').slice(prefix.length);
        const slash = rest.indexOf('/');
        names.add(slash === -1 ? rest : rest.slice(0, slash));
      }
      return [...names].sort();
    },

    get(vault, key) {
      const row = getQ.get(vault, key);
      if (row === undefined) return null;
      const { body } = row;
      if (!(body instanceof Uint8Array)) throw new Error('objects.body is not a blob');
      return { body, etag: stringIn(row, 'etag') };
    },

    put(vault, key, body, etag, now, mayGrow = true) {
      // IMMEDIATE takes the write lock before the usage read, so the read cannot go stale before the write.
      db.exec('BEGIN IMMEDIATE');
      try {
        const old = sizeQ.get(vault, key);
        const oldSize = old === undefined ? 0 : numberIn(old, 'size');
        const before = usage(vault);
        const overQuota = before.bytes - oldSize + body.length > quota.bytes || before.objects + (old === undefined ? 1 : 0) > quota.objects;
        const result: PutResult = overQuota ? 'over-quota' : !mayGrow && body.length > oldSize ? 'no-room' : 'stored';
        if (result === 'stored') upsertQ.run(vault, key, etag, body.length, now, body);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    },

    delete(vault, key) {
      deleteQ.run(vault, key);
    },

    usage,

    purgeIdle(before) {
      const gone = new Set(purgeQ.all(before).map((row) => stringIn(row, 'vault')));
      // auto_vacuum = INCREMENTAL keeps freed pages until asked; this returns them to the volume.
      db.exec('PRAGMA incremental_vacuum');
      return gone.size;
    },

    ping() {
      pingQ.get();
    },

    close() {
      db.close();
    },
  };
}
