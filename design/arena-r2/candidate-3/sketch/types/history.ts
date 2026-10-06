// History as the second data type. A record is one immutable visit. Its identity is a hash of (url, time),
// so the same visit read on two devices, or read back after the file-mode host imported it, is the same
// ItemId. That is what makes echoes harmless and file mode idempotent (see DESIGN.md "History").
//
// What this file knows: the record shape, what a safe remote url is, sharding by UTC day, the 90-day window.
// What it does not know: chrome.history, the corpus, or the native host (adapters/chrome-history.ts).
import type { DataType, ItemId, ShardKey } from '../model.ts';

/** Same window Chromium keeps (P5: 90 days, 45,970 visits, 1.9 MB gzip full state). Fixed, not a setting. */
export const HISTORY_RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;

/** chrome.history TransitionType, kept verbatim so the file-mode host can map it back to Chromium's integers. */
export type Via =
  | 'link' | 'typed' | 'auto_bookmark' | 'auto_subframe' | 'manual_subframe' | 'generated'
  | 'auto_toplevel' | 'form_submit' | 'reload' | 'keyword' | 'keyword_generated';

/**
 * Immutable in practice. Every field is still a register (the generic layer has no other shape), but a
 * visit is only ever written once, so its registers carry the one stamp of the cycle that first saw it.
 * gzip collapses those repeated stamps (all visits added in one cycle share one), so this costs little.
 * `title` is the page title when we first observed the visit. The adapter reuses the previous record for
 * a known id, so a retitled page does not re-stamp its old visits.
 */
export type Visit = {
  readonly kind: 'visit';
  readonly url: string;
  readonly title: string;
  /** Visit time, whole ms since the Unix epoch. */
  readonly time: number;
  readonly via: Via;
};

/**
 * FNV-1a 64 over `${time}\n${url}`, base36, prefixed 'v'. Every device must compute the same id, so the
 * algorithm is part of the format. 64 bits keeps a collision among 100k visits near 1e-9, and a collision
 * would merge two visits of one page at one millisecond, which is harmless.
 */
export function visitId(_url: string, _time: number): ItemId {
  // Pure. The result is checked with isItemId before it leaves, so no cast is needed.
  throw new Error('not implemented');
}

/** Only http(s). The corpus page opens these urls, so a hostile peer file must never smuggle in `javascript:` or `file:`. */
export function isSyncableUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** UTC day, `YYYY-MM-DD`. UTC so every device files the same visit in the same shard. */
export function dayOf(_timeMs: number): ShardKey {
  throw new Error('not implemented');
}

export const history: DataType<Visit> = {
  version: 1,

  shardOf: (v) => dayOf(v.time),
  expired: (v, nowMs) => v.time < nowMs - HISTORY_RETENTION_DAYS * DAY_MS,

  parseRecord(_raw) {
    // kind 'visit', http(s) url, title string (truncate to 512), integer time, `via` in the Via set. Else null.
    throw new Error('not implemented');
  },

  adopt({ local }) {
    // Ids are content-addressed, so the same visit already has the same id everywhere. Nothing to map.
    return { live: local, aliases: new Map() };
  },

  normalize: (live) => live, // Visits reference nothing, so a merge cannot break an invariant.

  label: (v) => v.title || new URL(v.url).host,
};
