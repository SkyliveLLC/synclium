// The log model's cycle. History runs through it; open tabs or an extension list would too. No HLC, no
// tombstones, no merge: each device publishes only its own events, one shard per UTC day, and readers replace a
// peer's day whole when its manifest hash changes. A deleted event leaves its author's shard when that day is
// re-derived, and peers drop it on the next pull. Only the author ever held it in a file, so nothing can
// resurrect it.
import type { DayKey, Ev, LogType } from './model.ts';
import type { LogCursor, LogPorts } from './ports.ts';
import type { CycleContext, LogOutcome, Wanted, Warning } from './engine.ts';
import type { RelName } from './store-format.ts';

export type LogStep = {
  readonly cursor: LogCursor;
  readonly outcome: LogOutcome;
  /** Every own day the device holds, touched this cycle or not. A file leaves the manifest only by expiry. */
  readonly wanted: ReadonlyMap<RelName, Wanted>;
  /** Own days past retention. The engine deletes them locally only after their file left the store. */
  readonly expired: readonly DayKey[];
  readonly warnings: readonly Warning[];
  /** false when the budget cut the derive walk or the pull. */
  readonly complete: boolean;
};

/*
 * syncLog(ctx, type, { source, sink, local }, cursor, rederive). Each numbered step is one unit of work or a
 * loop of units; ctx.budget is checked before each unit. Every unit commits on its own, so stopping loses nothing.
 *
 *   0. rederive (the scheduler's ask), or lastWalk older than rederiveDays:
 *        cursor.derive = { next: today, oldest: today - retentionDays + 1 }       // committed with handled asks
 *   1. scan:   events = source.collect(watermark - slackMs, now)
 *              append into own days (union by type.key); watermark = now
 *   2. derive: while cursor.derive and budget left:                               // join backfill = re-derive
 *              d = cursor.derive.next
 *              own day d = exactly source.collect(dayRange(d)), so local deletes leave the shard
 *              cursor.derive.next = d - 1, or null past `oldest`
 *   Both 1 and 2 apply the echo rule first:
 *              events = events minus local.ingested(keys)   // a peer's visit written into this profile (companion)
 *                                                          // has the peer's key, and is never republished as ours
 *              saveOwnDay(d, events, { plain: plaintextHash(shard body), count }) per changed day
 *   3. pull (store only), newest day first, while budget left:
 *              per live peer p, per shard entry (day, hash) in p's manifest within retention,
 *              where hash != local.peerDays[key]:
 *                open(get(key), codec, entry) -> parseLogShard
 *                not-yet          -> warn, keep what is indexed                   // the last good copy stands
 *                ok               -> sink.put(p, day, events); local.markIngested(keys); local.setPeerDay(key, hash)
 *              per indexed key whose peer is no longer live, or whose day left p's manifest:
 *                sink.drop(p, day); local.setPeerDay(key, null)
 *   4. expire: own days older than retention -> `expired`; local.expire(now - retention)
 *   5. wanted = per own day: { plain, body: () => encodeLogShard(ownEvents(day)) }
 *
 * Sink first, then the marks: a crash re-ingests, and the sink replaces by (peer, day). Idempotent end to end:
 * own days are a function of Helium's history, the index a function of peers' shards.
 */
export function syncLog<E extends Ev>(
  _ctx: CycleContext,
  _type: LogType<E>,
  _ports: LogPorts<E>,
  _cursor: LogCursor,
  _rederive: boolean,
): Promise<LogStep> {
  throw new Error('not implemented');
}

/** A fresh device's cursor: scan from now, and walk back over the whole retention window, newest day first. */
export function joinCursor(_now: number, _retentionDays: number): LogCursor {
  throw new Error('not implemented');
}

export function dayOf(_t: number): DayKey {
  throw new Error('not implemented');
}

/** [start, end) of a UTC day in ms. */
export function dayRange(_day: DayKey): readonly [number, number] {
  throw new Error('not implemented');
}
