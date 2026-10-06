// History's LogSource over chrome.history. Read-only: helium-sync never calls addUrl, deleteUrl, or deleteRange.
import { isSyncableUrl, type Visit } from './history.ts';
import type { LogSource } from './ports.ts';

/** getVisits calls in flight at once. One derived day is about 190 urls (P5), so a day costs ~10 rounds. */
const PARALLEL = 20;

/**
 * collect(from, to): history.search lists urls visited in [from, to), then getVisits per url keeps this device's
 * own (isLocal) http(s) visits with from <= t < to. `maxResults: 0` means "no limit" (observed on Helium 154).
 */
export function chromeHistorySource(): LogSource<Visit> {
  return {
    async collect(from, to) {
      const items = await chrome.history.search({ text: '', startTime: from, endTime: to, maxResults: 0 });
      const urls = items.flatMap((item) => (item.url !== undefined && isSyncableUrl(item.url) ? [{ url: item.url, title: item.title ?? '' }] : []));
      const visits: Visit[] = [];
      for (let i = 0; i < urls.length; i += PARALLEL) {
        const batch = urls.slice(i, i + PARALLEL);
        const found = await Promise.all(batch.map(({ url }) => chrome.history.getVisits({ url })));
        batch.forEach(({ url, title }, k) => {
          for (const v of found[k] ?? []) {
            const t = v.visitTime;
            if (v.isLocal && t !== undefined && t >= from && t < to) visits.push({ url, title, t });
          }
        });
      }
      return visits;
    },
  };
}
