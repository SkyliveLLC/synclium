// The log model's cycle. History runs through it; open tabs or an extension list would too. No HLC, no
// tombstones, no merge: each device publishes only its own events, one shard per UTC day, and readers replace a
// peer's day whole when its manifest hash changes. A deleted event leaves its author's shard when that day is
// re-derived, and peers drop it on the next pull. Only the author ever held it in a file, so nothing can
// resurrect it.
//
// Each step is one unit of work or a loop of units; the budget is checked before each unit. Every unit commits
// on its own, so stopping loses nothing. Sink first, then the marks: a crash re-ingests, and the sink replaces
// by (peer, day). Own days are a function of Helium's history, the index a function of peers' shards.
import { DAY_MS, dayOf, dayRange, shiftDay, type DayKey, type DeviceId, type Ev, type LogType } from './model.ts';
import { deepEqual } from './crdt.ts';
import type { LogCursor, LogPorts } from './ports.ts';
import type { CycleContext, LogOutcome, Wanted, Warning } from './engine.ts';
import { encodeLogShard, keys, open, parseKey, parseLogShard, parseRel, plaintextHash, shardRel, sortEvents, type FileEntry, type RelName, type StoreKey } from './store-format.ts';

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

export type LogOptions = {
  /** The scheduler's ask: re-derive every own day. */
  readonly rederive: boolean;
  /** Persist the cursor. Runs after every unit. */
  readonly commit: (cursor: LogCursor) => Promise<void>;
};

/** A fresh device's cursor: scan from now, and walk back over the whole retention window, newest day first. */
export function joinCursor(now: number, retentionDays: number): LogCursor {
  const today = dayOf(now);
  return { watermark: now, derive: { next: today, oldest: shiftDay(today, -(retentionDays - 1)) }, lastWalk: 0 };
}

const daysInclusive = (from: DayKey, to: DayKey): number => Math.round((dayRange(to)[0] - dayRange(from)[0]) / DAY_MS) + 1;

export async function syncLog<E extends Ev>(ctx: CycleContext, type: LogType<E>, { source, sink, local }: LogPorts<E>, cursor: LogCursor, opts: LogOptions): Promise<LogStep> {
  const today = dayOf(ctx.now);
  const oldestKept = shiftDay(today, -(type.retentionDays - 1));
  const warnings: Warning[] = [];
  let c = cursor;
  let complete = true;
  let collected = 0;
  let pulled = 0;

  const shardBody = (day: DayKey, events: readonly E[]) => encodeLogShard({ device: ctx.me.device, type: type.name, typeVersion: type.version, day, events });

  /** The echo rule: a peer's event this device handed its sink is never republished as this device's own. */
  const withoutEchoes = async (events: readonly E[]): Promise<E[]> => {
    const echoes = await local.ingested(events.map((e) => type.key(e)));
    const seen = new Set(echoes);
    return events.filter((e) => {
      const key = type.key(e);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const saveOwnDay = async (day: DayKey, events: readonly E[]) => {
    if (events.length === 0) return local.deleteOwnDay(day);
    const sorted = sortEvents(events, type);
    await local.saveOwnDay(day, sorted, { plain: await plaintextHash(shardBody(day, sorted)), count: sorted.length });
  };

  if (opts.rederive || (c.derive === null && ctx.now - c.lastWalk >= ctx.policy.log.rederiveDays * DAY_MS)) {
    c = { ...c, derive: { next: today, oldest: oldestKept } };
    await opts.commit(c);
  }

  // Scan: new own events since the watermark, appended into their days.
  if (ctx.budget.expired()) complete = false;
  else {
    const fresh = await withoutEchoes(await source.collect(c.watermark - ctx.policy.log.slackMs, ctx.now));
    const byDay = new Map<DayKey, E[]>();
    for (const event of fresh) {
      const day = dayOf(event.t);
      if (day < oldestKept) continue;
      const list = byDay.get(day);
      if (list === undefined) byDay.set(day, [event]);
      else list.push(event);
    }
    for (const [day, events] of byDay) {
      const existing = await local.ownEvents(day);
      const known = new Set(existing.map((e) => type.key(e)));
      const added = events.filter((e) => !known.has(type.key(e)));
      if (added.length === 0) continue;
      collected += added.length;
      await saveOwnDay(day, [...existing, ...added]);
    }
    c = { ...c, watermark: ctx.now };
    await opts.commit(c);
  }

  // Derive: one day per unit becomes exactly what Helium shows for it, so local deletes leave the shard.
  while (c.derive !== null) {
    if (ctx.budget.expired()) {
      complete = false;
      break;
    }
    const day = c.derive.next;
    if (day >= oldestKept) {
      const [start, end] = dayRange(day);
      const events = sortEvents(await withoutEchoes(await source.collect(start, end)), type);
      if (!deepEqual(await local.ownEvents(day), events)) await saveOwnDay(day, events);
    }
    const next = shiftDay(day, -1);
    c = next < c.derive.oldest ? { ...c, derive: null, lastWalk: ctx.now } : { ...c, derive: { ...c.derive, next } };
    await opts.commit(c);
  }

  // Pull: peers' shards whose manifest hash differs from the one applied, newest day first.
  const peerDays = await local.peerDays();
  type Candidate = { readonly peer: DeviceId; readonly name: string; readonly day: DayKey; readonly key: StoreKey; readonly entry: FileEntry };
  const candidates: Candidate[] = [];
  for (const [peer, manifest] of ctx.live)
    for (const [rel, entry] of manifest.files) {
      const parsed = parseRel(rel);
      if (parsed?.kind !== 'shard' || parsed.type !== type.name || parsed.day < oldestKept) continue;
      const key = keys.file(peer, rel);
      if (peerDays.get(key) !== entry.hash) candidates.push({ peer, name: manifest.name, day: parsed.day, key, entry });
    }
  candidates.sort((a, b) => (a.day > b.day ? -1 : a.day < b.day ? 1 : a.peer < b.peer ? -1 : a.peer > b.peer ? 1 : 0));
  for (const candidate of candidates) {
    if (ctx.budget.expired()) {
      complete = false;
      break;
    }
    const fetched = await ctx.store.use((store) => store.get(candidate.key, null));
    if (fetched === null) break;
    const file = `${type.name}/${candidate.day}`;
    if (fetched.kind !== 'ok') {
      warnings.push({ kind: 'not-yet', peer: candidate.peer, file });
      continue;
    }
    const opened = await open(fetched.bytes, ctx.codec, candidate.entry);
    switch (opened.kind) {
      case 'ok': {
        const parsed = parseLogShard(opened.body, type, { device: candidate.peer, day: candidate.day });
        switch (parsed.kind) {
          case 'ok':
            await sink.put({ device: candidate.peer, name: candidate.name }, candidate.day, parsed.file.events);
            await local.markIngested(parsed.file.events.map((e) => ({ key: type.key(e), t: e.t })));
            await local.setPeerDay(candidate.key, candidate.entry.hash);
            pulled++;
            break;
          case 'newer-type-version':
            warnings.push({ kind: 'newer-version', peer: candidate.peer, file, version: parsed.version });
            break;
          case 'invalid':
            warnings.push({ kind: 'not-yet', peer: candidate.peer, file });
            break;
          default: {
            const unreachable: never = parsed;
            return unreachable;
          }
        }
        break;
      }
      case 'not-yet':
        warnings.push({ kind: 'not-yet', peer: candidate.peer, file });
        break;
      case 'newer-format':
        warnings.push({ kind: 'newer-version', peer: candidate.peer, file, version: opened.formatVersion });
        break;
      case 'unknown-codec':
        warnings.push({ kind: 'unknown-codec', peer: candidate.peer, codec: opened.codec });
        break;
      default: {
        const unreachable: never = opened;
        return unreachable;
      }
    }
  }

  // Drop indexed days whose peer went idle, whose day left its manifest, or which fell out of retention.
  for (const key of peerDays.keys()) {
    const parsed = parseKey(key);
    if (parsed === null || parsed.rel.kind !== 'shard' || parsed.rel.type !== type.name) continue;
    const listed = ctx.live.get(parsed.device)?.files.has(parsed.rel.rel) ?? false;
    if (listed && parsed.rel.day >= oldestKept) continue;
    await sink.drop(parsed.device, parsed.rel.day);
    await local.setPeerDay(key, null);
  }

  // Expire own days, and report every kept day as wanted.
  const ownDays = await local.ownDays();
  const expired = [...ownDays.keys()].filter((day) => day < oldestKept);
  await local.expire(ctx.now - type.retentionDays * DAY_MS);
  const wanted = new Map<RelName, Wanted>();
  for (const [day, meta] of ownDays) {
    if (day < oldestKept) continue;
    wanted.set(shardRel(type, day), { plain: meta.plain, body: async () => shardBody(day, await local.ownEvents(day)) });
  }
  return {
    cursor: c,
    // The engine fills in published and unpublished counts after its publish phase.
    outcome: {
      kind: 'synced',
      collected,
      publishedDays: 0,
      unpublishedDays: wanted.size,
      pulledDays: pulled,
      deriveDaysLeft: c.derive === null ? 0 : daysInclusive(c.derive.oldest, c.derive.next),
    },
    wanted,
    expired,
    warnings,
    complete,
  };
}
