// History, the second data type. Not a replica type: a visit is an immutable fact with one author, so each
// device publishes only its own visits, sharded by UTC day, and readers take the union. No registers, no
// tombstones, no merge. Deleting a visit locally re-derives the owner's shard without it, and peers drop it
// from their index when the shard's version changes.
//
// "Apply" means: index peers' visits in IndexedDB, searchable from the History tab and the omnibox keyword.
// helium-sync never calls history.addUrl (it would stamp every remote visit "now" and pollute today's
// history). Real visit times in Helium's own history are the opt-in companion's job (companion.ts).
import type { Brand, DeviceId } from './model.ts';
import type { HistoryDb, HistoryLocal, HistorySource, Store } from './ports.ts';
import type { Codec } from './store-format.ts';

/** UTC calendar day, `yyyy-mm-dd`. UTC so every device cuts days at the same instant. */
export type DayKey = Brand<string, 'DayKey'>;

/** Plain data. `t` is chrome's visitTime: ms since epoch, fractional, unique per url in practice. */
export type Visit = { readonly url: string; readonly title: string; readonly t: number };

/** `url + NUL + t`. Identity across devices, so a visit two devices both hold is shown once. */
export type VisitKey = Brand<string, 'VisitKey'>;

export function visitKey(_v: Visit): VisitKey {
  throw new Error('not implemented');
}
export function dayOf(_t: number): DayKey {
  throw new Error('not implemented');
}
/** [start, end) of a UTC day in ms. */
export function dayRange(_day: DayKey): readonly [number, number] {
  throw new Error('not implemented');
}

export type HistoryPolicy = {
  /** Matches Chromium's 90-day expiry. Owners delete older shards; readers drop older index entries. */
  readonly retentionDays: number;
  /** Full re-derive at least this often, to catch deletes the removal event did not describe. */
  readonly rederiveDays: number;
  /** Re-read this much before the watermark, because Chromium commits history in ~10 s batches. */
  readonly slackMs: number;
};
export const defaultHistoryPolicy: HistoryPolicy = { retentionDays: 90, rederiveDays: 7, slackMs: 60_000 };

// ---------- Pure ----------

/**
 * Next content of own days after a scan. `append` (incremental scan) unions the scanned visits into the
 * days they fall on. `replace` (re-derive) makes each scanned day equal exactly the scanned visits, which
 * is how local deletes leave the shard. Returns only days whose content changed.
 */
export function foldScan(
  _current: ReadonlyMap<DayKey, readonly Visit[]>,
  _scanned: readonly Visit[],
  _mode: 'append' | 'replace',
  _range: readonly [number, number],
): ReadonlyMap<DayKey, readonly Visit[]> {
  throw new Error('not implemented');
}

/** Days older than the retention window, relative to `now`. */
export function expiredDays(_days: Iterable<DayKey>, _now: number, _retentionDays: number): readonly DayKey[] {
  throw new Error('not implemented');
}

// ---------- The step engine.ts runs ----------

export type HistoryInput = {
  readonly device: DeviceId;
  readonly local: HistoryLocal;
  readonly source: HistorySource;
  readonly db: HistoryDb;
  /** null when the folder is not reachable: own days still update locally, publishing and pulling wait. */
  readonly store: Store | null;
  /** Live, non-idle peers. Shards of anyone else are neither read nor dropped. */
  readonly peers: ReadonlySet<DeviceId>;
  readonly codec: Codec;
  readonly now: number;
  readonly dryRun: boolean;
  readonly policy: HistoryPolicy;
};

export type HistoryOutcome =
  | { readonly kind: 'synced'; readonly publishedDays: number; readonly pulledShards: number; readonly peerVisits: number }
  | { readonly kind: 'local-only'; readonly unpublishedDays: number };

/*
 * syncHistory(input):
 *
 *   scan     = local.rederive or lastRederive older than rederiveDays
 *                ? replace over [now - retention, now)                    // ~17k getVisits, rare
 *                : append over  [watermark - slack, now)                  // a few dozen urls
 *   visits   = source.visitsBetween(range) minus db.knownFromPeers(...)   // never republish a companion-written peer visit
 *   changed  = foldScan(own days, visits, mode, range)
 *   per changed day d:  db.saveOwnDay(d, { rev: rev + 1, pushedRev }, visits)      // commit first (round 1's rule, per day)
 *   per own day with pushedRev < rev, if store:                         // this cycle's changes, plus any a crash or an
 *     store.put(keys.historyShard(me, d), seal(shard)); save pushedRev = rev   // unreachable folder left behind
 *   per expiredDays(own days), if store: store.delete(shard); db.deleteOwnDay(d)   // forget a day only once its file is gone
 *   local'   = { watermark: now, rederive: false, lastRederive: scan was replace ? now : old }
 *
 *   pull, only if store:
 *     entries = store.list("devices/") parsed as history keys of live peers
 *     per entry, downloaded and version != db.peerShards()[key].version:
 *       shard = parseShard(open(get(key)))
 *       shard.rev < indexed rev    -> warn rollback, keep the index      // a rolled-back shard could resurrect a deleted visit
 *       else                       -> db.replacePeerShard(meta, shard.visits minus days past retention)
 *     per indexed shard of a live peer that the listing no longer has  -> db.dropPeerShard   // owner deleted or expired it
 *
 * Idempotent: own days are a function of Helium's history, peer index entries a function of peer shards.
 * A crash anywhere leaves either the old or the new content per day, and the next cycle converges.
 */
export function syncHistory(_input: HistoryInput): Promise<{ readonly local: HistoryLocal; readonly outcome: HistoryOutcome }> {
  throw new Error('not implemented');
}

// ---------- chrome.history adapter ----------

/** history.search({ text: '', startTime, endTime, maxResults: 0 }) then getVisits per url, filtered to range, isLocal, http(s). */
export function chromeHistorySource(): HistorySource {
  return {
    async visitsBetween(_from, _to) {
      throw new Error('not implemented');
    },
  };
}
