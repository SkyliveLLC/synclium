// A fake chrome.history: visits this profile made, queryable by time range. `add` is a page visit; `echo` is
// what the opt-in companion would do, writing a peer's visit into this profile at its real time.
import { DAY_MS, dayOf, type DayKey } from '../../src/model.ts';
import type { Visit } from '../../src/history.ts';
import type { LogSource } from '../../src/ports.ts';

export class FakeHistory implements LogSource<Visit> {
  readonly visits: Visit[] = [];

  add(visit: Visit): Visit {
    this.visits.push(visit);
    return visit;
  }

  remove(predicate: (v: Visit) => boolean): number {
    const before = this.visits.length;
    for (let i = this.visits.length - 1; i >= 0; i--) {
      const v = this.visits[i];
      if (v !== undefined && predicate(v)) this.visits.splice(i, 1);
    }
    return before - this.visits.length;
  }

  async collect(from: number, to: number): Promise<readonly Visit[]> {
    return this.visits.filter((v) => v.t >= from && v.t < to);
  }

  byDay(): ReadonlyMap<DayKey, readonly Visit[]> {
    const out = new Map<DayKey, Visit[]>();
    for (const v of this.visits) {
      const day = dayOf(v.t);
      const list = out.get(day);
      if (list === undefined) out.set(day, [v]);
      else list.push(v);
    }
    return out;
  }
}

/**
 * P5-shaped days: `perDay` visits a day over `days` days ending at `now`, a few urls repeating. Deterministic,
 * so a crashed scenario replays the same profile.
 */
export function visitsOver(now: number, days: number, perDay: number, host: string): Visit[] {
  const out: Visit[] = [];
  for (let d = 0; d < days; d++) {
    const dayStart = Math.floor((now - d * DAY_MS) / DAY_MS) * DAY_MS;
    for (let i = 0; i < perDay; i++) {
      const t = dayStart + 3_600_000 + i * 60_000 + 0.25;
      if (t >= now) continue;
      out.push({ url: `https://${host}/page/${(d * 7 + i) % 23}`, title: `Page ${(d * 7 + i) % 23} on ${host}`, t });
    }
  }
  return out;
}
