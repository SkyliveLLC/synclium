// History as a log type. A visit is a fact: this device loaded this url at this time. Nobody edits it,
// so there are no registers and no tombstones. A device publishes only its own visits, one file per UTC
// day, and merging is set union. P5 sized the alternative (full per-visit state per device, rewritten
// every cycle) at 1.9 MB gzip; a day shard is ~15 KB and only today's shard changes.
import type { Ev, LogType } from '../model.ts';

/** chrome.history transition names, kept verbatim so a future file-mode import can map them to Chromium's enum. */
export type Transition = chrome.history.TransitionType;

export type Visit = Ev & {
  /** Wall ms of the visit. From chrome.history, so it is the real time, not the sync time. */
  readonly t: number;
  readonly url: string;
  /** Page title as chrome.history knew it when the visit was collected. */
  readonly title: string;
  readonly transition: Transition;
};

export const history: LogType<Visit> = {
  model: 'log',
  version: 1,
  retentionDays: 90,

  parseEvent(_raw) {
    // { t: finite number, url: parseable http(s)/file/ftp URL, title: string, transition: known name }.
    throw new Error('not implemented');
  },

  key(_v) {
    // `${t}|${url}`. Chromium stores visit_time in µs; the API rounds to ms, which is still unique per url in practice.
    throw new Error('not implemented');
  },

  label(_v) {
    throw new Error('not implemented');
  },
};
