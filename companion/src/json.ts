// JSON values from files and from the wire, narrowed without casts, plus the atomic file write both stores use.
import { closeSync, fsyncSync, openSync, renameSync, statSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Json } from '../../extension/src/model.ts';

export type JsonRecord = { readonly [k: string]: Json };

export const isRecord = (v: unknown): v is JsonRecord => typeof v === 'object' && v !== null && !Array.isArray(v);

export function isJson(v: unknown): v is Json {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(isJson);
  return typeof v === 'object' && Object.values(v).every(isJson);
}

/** A JSON object document, or an error naming the file. */
export function parseJsonRecord(text: string, what: string): JsonRecord {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || !isJson(parsed)) throw new Error(`${what} is not a JSON object`);
  return parsed;
}

/** The value at a dotted path, or undefined. */
export function valueAt(root: Json, path: string): Json | undefined {
  let node: Json | undefined = root;
  for (const key of path.split('.')) node = isRecord(node) ? node[key] : undefined;
  return node;
}

/**
 * Replace `path` with a temp file written beside it, so a reader sees the old bytes or the new ones, never a
 * torn file. Keeps the original's mode (Chromium writes its files 0600).
 */
export function writeFileAtomic(path: string, data: string): void {
  let mode = 0o600;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    // New file: keep 0600.
  }
  const temp = join(dirname(path), `.${basename(path)}.helium-sync-${process.pid}.tmp`);
  const fd = openSync(temp, 'w', mode);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}
