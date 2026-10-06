// History's LogSource over chrome.history. Read-only: helium-sync never calls addUrl, deleteUrl, or deleteRange.
import type { Visit } from './history.ts';
import type { LogSource } from './ports.ts';

/**
 * collect(from, to): history.search({ text: '', startTime: from, endTime: to, maxResults: 0 }) lists urls
 * visited in range, then getVisits({ url }) per url, keeping isLocal, http(s) visits with from <= t < to.
 * A one-day derive unit calls getVisits once per url visited that day (P5: about 17k urls over 90 days).
 * Whether maxResults: 0 means "no limit" on Helium 154 is unverified; the fallback is a large constant.
 */
export function chromeHistorySource(): LogSource<Visit> {
  return {
    async collect(_from, _to) {
      throw new Error('not implemented');
    },
  };
}
