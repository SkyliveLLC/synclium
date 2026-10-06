// History as a DataType. This is why file-first exists: the file adapter is the only path that preserves visit
// times (P1; history.addUrl cannot set visitTime). Visits are grow-only items with no mutable fields, so they
// ride the same register model: `deleted` is always false and the merge degenerates to a union.

import { defineDataType, type ItemId, type Snapshot } from '../datatype.ts';
import type { ProfileDir, WritableProfile } from '../profile.ts';

export type HistoryFields = {
  readonly url: string;
  readonly title: string;
  /** Chromium µs since 1601-01-01, as a number (safe below 2^53 until ~2255). Read with readBigInts, narrowed here. */
  readonly visitTime: number;
  readonly transition: number;
};

/**
 * sha1(url + '\0' + visitTime). Deterministic from the row alone, so a visit imported on device B hashes to the
 * same id when B reads it back and is not re-pushed as a new item.
 */
export function visitId(url: string, visitTime: number): ItemId {
  throw new Error('not implemented');
}

/** Matches Chromium's own expiry; bounds the device file to a few hundred KB gzipped for a heavy user. */
export const HORIZON_DAYS = 90;

/** `meta.version` values the write path has been exercised against. Anything else -> SchemaUnsupported. */
export const TESTED_SCHEMA_VERSIONS: ReadonlySet<number> = new Set([/* TODO fill from Helium 154 */]);

/**
 * P1: a plain read-only open hits SQLITE_BUSY while Helium runs. Copy the main file (journal_mode=delete, so
 * the copy is consistent at the last commit, ~10s stale) and open with `?immutable=1`.
 * select visits join urls where visit_time > now - HORIZON.
 */
async function read(profile: ProfileDir, _baseline: Snapshot<HistoryFields> | null): Promise<Snapshot<HistoryFields>> {
  throw new Error('not implemented');
}

/**
 * Closed window only. Check `meta.version` ∈ TESTED_SCHEMA_VERSIONS or throw SchemaUnsupported.
 * Work on `profile.scratchCopy('History')`: for each target visit whose id is not already present, upsert the
 * urls row (bump visit_count, last_visit_time) and insert the visits row with the original visit_time and
 * transition. Then `profile.replace('History', bytes)`. The -journal file is absent when Helium is closed.
 */
async function write(profile: WritableProfile, target: Snapshot<HistoryFields>): Promise<void> {
  throw new Error('not implemented');
}

export const history = defineDataType<HistoryFields>({
  name: 'history',
  fieldKeys: ['url', 'title', 'visitTime', 'transition'],
  read,
  write,
  // adopt: identity. Ids are content-derived, so two devices that visited the same url at the same µs agree already.
  // repair: identity. No cross-item invariants.
});
