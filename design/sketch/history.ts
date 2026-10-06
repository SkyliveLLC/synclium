// History as a log type. A visit is an immutable fact with exactly one author, so each device publishes only
// its own visits, sharded by UTC day, and readers take the union (see log-cycle.ts).
//
// "Apply" for history means: index peers' visits in IndexedDB, searchable from the History page and the
// omnibox keyword `hs`. helium-sync never calls history.addUrl, which would stamp every remote visit "now" and
// flood today's history (P2, P5). Real visit times in Helium's own history are the opt-in companion's job.
import type { EventKey, LogType } from './model.ts';

/** `t` is chrome's visitTime: ms since epoch, fractional (Chromium keeps µs). */
export type Visit = { readonly url: string; readonly title: string; readonly t: number };

export const history: LogType<Visit> = {
  model: 'log',
  name: 'history',
  version: 1,
  retentionDays: 90,

  parseEvent(_raw) {
    // { url: http(s) only, title: string truncated to 512, t: finite number }. Else null.
    // http(s) only because the History page opens these urls, and a peer file must never smuggle in
    // `javascript:` or `file:`.
    throw new Error('not implemented');
  },

  /**
   * `url + NUL + round(t * 1000)`. Integer µs, so a visit the companion wrote into History SQLite reads back
   * with the same key the peer published (the echo rule depends on it).
   */
  key(_v): EventKey {
    throw new Error('not implemented');
  },

  label(_v) {
    throw new Error('not implemented');
  },
};
