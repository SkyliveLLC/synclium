// History as a log type. A visit is an immutable fact with exactly one author, so each device publishes only
// its own visits, sharded by UTC day, and readers take the union (see log-cycle.ts).
//
// "Apply" for history means: index peers' visits in IndexedDB, searchable from the History page and the
// omnibox keyword `hs`. helium-sync never calls history.addUrl, which would stamp every remote visit "now" and
// flood today's history (P2, P5). Real visit times in Helium's own history are the opt-in companion's job.
import type { EventKey, LogType } from './model.ts';

/** `t` is chrome's visitTime: ms since epoch, fractional (Chromium keeps µs). */
export type Visit = { readonly url: string; readonly title: string; readonly t: number };

const TITLE_MAX = 512;

/** http(s) only: the History page opens these urls, and a peer file must never smuggle in `javascript:` or `file:`. */
export function isSyncableUrl(url: string): boolean {
  return /^https?:\/\/\S+$/i.test(url);
}

export function visitKey(url: string, t: number): EventKey {
  // Integer µs, so a visit the companion wrote into History SQLite reads back with the same key the peer
  // published (the echo rule depends on it).
  const key: string = `${url}\u0000${Math.round(t * 1000)}`;
  return key as EventKey;
}

export const history: LogType<Visit> = {
  model: 'log',
  name: 'history',
  version: 1,
  retentionDays: 90,

  parseEvent(raw) {
    if (typeof raw !== 'object' || raw === null || !('url' in raw) || !('t' in raw)) return null;
    const { url, t } = raw;
    const title = 'title' in raw ? raw.title : '';
    if (typeof url !== 'string' || !isSyncableUrl(url) || typeof t !== 'number' || !Number.isFinite(t) || typeof title !== 'string') return null;
    return { url, title: title.slice(0, TITLE_MAX), t };
  },

  key: (v) => visitKey(v.url, v.t),

  label(v) {
    return v.title === '' ? v.url : v.title;
  },
};
