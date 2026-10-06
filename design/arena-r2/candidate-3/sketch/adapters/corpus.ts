// The corpus: synced visits that are NOT in Helium's own history. In default mode that is every remote
// visit, because history.addUrl cannot set a visit time (P2). It is a read-optimised projection of the
// merged state, not a source of truth: drop it and the next cycle rebuilds it from `applied` and the store.
//
// Two interfaces, split by who may hold them (per separate-before-serializing-shared-state):
//   CorpusReader  pages and the omnibox. Read-only IndexedDB handle, works while the worker sleeps.
//   Corpus        the worker only, inside the cycle lock. Adds the writes.
import type { Live, ShardKey } from '../model.ts';
import type { Visit } from '../types/history.ts';

export type HistoryQuery = {
  /** Case-insensitive substring over title and url. Empty means "newest first". */
  readonly text: string;
  readonly day?: ShardKey;
  readonly limit: number;
  /** Cursor from the previous page's last hit, for infinite scroll. */
  readonly before?: number;
};

export type CorpusHit = { readonly id: string; readonly visit: Visit };

export interface CorpusReader {
  /** Newest first. Cursor scan over the `time` index with early exit, no full-text index in v1 (50k visits scans in tens of ms). */
  search(query: HistoryQuery): Promise<readonly CorpusHit[]>;
  /** Days that have visits, newest first, with counts. Drives the history page's day list. */
  days(): Promise<readonly { readonly day: ShardKey; readonly count: number }[]>;
}

export interface Corpus extends CorpusReader {
  /** Everything in the corpus, for ChromeHistory.read (the profile "shows" native history plus the corpus). */
  all(): Promise<Live<Visit>>;
  /**
   * One IndexedDB transaction: remove `remove`, add `add`. A visit also present natively is dropped, native wins.
   * All or nothing, so a kill mid-apply cannot leave half a shard.
   */
  write(change: { readonly add: Live<Visit>; readonly remove: readonly string[] }): Promise<void>;
}

/** Database `helium-sync-corpus`. Stores: `visits` keyed by id, indexes `time` and `day`. */
export function openCorpusReader(): Promise<CorpusReader> {
  throw new Error('not implemented');
}
export function openCorpus(): Promise<Corpus> {
  throw new Error('not implemented');
}
