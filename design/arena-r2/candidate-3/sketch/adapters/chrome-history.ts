// History channel over chrome.history plus the corpus. This is where "apply can't set visit time" is decided.
//
//   The profile "shows" = native Helium history  UNION  the corpus.
//
//   read     native visits (chrome.history) plus corpus visits. Remote visits must be in `observed`, or the fold
//            would read their absence as a local delete and tombstone every remote visit.
//   apply    an add goes to the corpus, never to chrome.history (addUrl stamps "now"; P2).
//            A remove drops the corpus copy, or, for a visit that is native here, deletes exactly that visit.
//            Visits are immutable, so there is no update.
//
// Native reads are incremental. chrome.history has no per-visit change feed, so the adapter keeps a small
// index `url -> (lastVisitTime, visitCount, ids)` in its own IndexedDB. A cycle runs one history.search over
// the window (O(urls), tens of ms) and calls getVisits only for urls whose signature changed.
import type { WriteChannel } from '../ports.ts';
import type { Visit } from '../types/history.ts';
import type { Corpus } from './corpus.ts';

/** The three chrome.history calls the adapter needs. A seam so tests do not need a browser. */
export interface NativeHistory {
  /** One row per url in [sinceMs, now], with the signature fields. maxResults is raised from its default of 100. */
  urls(sinceMs: number): Promise<readonly { readonly url: string; readonly title: string; readonly lastVisit: number; readonly count: number }[]>;
  visits(url: string): Promise<readonly { readonly time: number; readonly via: Visit['via'] }[]>;
  /** history.deleteRange over [timeMs, timeMs + 1). Refuses (returns false) if another url has a visit in that millisecond. */
  deleteVisit(timeMs: number, url: string): Promise<boolean>;
}

/** The real chrome.history behind the seam. */
export function chromeNativeHistory(): NativeHistory {
  throw new Error('not implemented');
}

export type ChromeHistoryDeps = {
  readonly native: NativeHistory;
  readonly corpus: Corpus;
  readonly nowMs: () => number;
};

export function chromeHistory(_deps: ChromeHistoryDeps): WriteChannel<Visit> {
  // read(previous):
  //   since   = now - HISTORY_RETENTION_DAYS
  //   native  = for each url whose signature changed: visits(url) -> Visit { id: visitId(url, time) }
  //             titles come from the previous record for a known id, so a retitled page does not re-stamp old visits
  //   return  native + corpus.all()     // ids are content hashes, so a visit present in both appears once
  //
  // apply({ shard, current, target }):
  //   for add id:     corpus.write.add            (it is remote by construction, else it would be in `current`)
  //   for remove id:  in corpus -> corpus.write.remove; native -> native.deleteVisit(time, url)
  //   all corpus changes of one shard in a single transaction; return { kind: 'applied' }
  // bind(): history ids need no aliases, so this is a no-op.
  throw new Error('not implemented');
}
