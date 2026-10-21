// Every number that bounds Synclium Cloud, in one table, plus the token bucket the rate limits run on.
//
// Sizing, from extension/src/store-format.ts: a device stores ~95 objects, a heavy one ~5 MB (bookmarks ~2 MB at
// 30k nodes, 90 days of history up to ~2 MB). One device makes 12 * (2D + 2) requests an hour in a D-device vault;
// a join into a 10-device vault is ~1,900 requests.
//
// Rate limits are in memory, per process: a restart forgets them (only ever loosening a limit), and during a
// rolling deploy the old and new container each keep their own, so a limit briefly doubles (accepted).

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/** A token bucket: `burst` at once, refilled at `perSecond`. */
export type Rate = { readonly burst: number; readonly perSecond: number };

export type Quota = { readonly bytes: number; readonly objects: number };

export type Limits = {
  /** One object. Over it: 413. */
  readonly objectBytes: number;
  /** One vault, every device under one sync key together: ~12 heavy devices, ~40 devices' objects. Over it: 507. */
  readonly vault: Quota;
  /** Every request per client IP (IPv6 per /64), preflights included, health exempt. Over it: 429. */
  readonly requests: Rate;
  /** Puts into a vault with no objects, per client IP, over a rolling day. Over it: 429. */
  readonly newVaults: Rate;
  /**
   * Disk guard: a put that grows the data answers 503 while the volume has less than `minFreeBytes` free or the
   * database and its WAL pass `maxDataBytes`. Replacing with fewer bytes and deleting still work.
   */
  readonly minFreeBytes: number;
  readonly maxDataBytes: number;
  readonly diskRetryAfterS: number;
  /** Request bodies being read at once. 32 x 8 MiB bounds body memory at 256 MiB in a 512 MiB container. */
  readonly bodiesInFlight: number;
  readonly busyRetryAfterS: number;
  /** A vault with no write for this long is deleted by the daily purge. Live devices rewrite their manifest daily. */
  readonly idleDays: number;
  /** How long a statfs reading of the volume is reused: the guard needs a trend, not a byte. */
  readonly diskCacheMs: number;
  /** A client that has not sent its headers by then is cut off. */
  readonly headersTimeoutMs: number;
  /** A whole request, body included: 8 MiB on a slow uplink. The extension's own timeout is the same. */
  readonly requestTimeoutMs: number;
};

export const LIMITS: Limits = {
  objectBytes: 8 * MiB,
  vault: { bytes: 64 * MiB, objects: 4096 },
  requests: { burst: 3000, perSecond: 20 },
  newVaults: { burst: 20, perSecond: 20 / 86_400 },
  minFreeBytes: 2 * GiB,
  maxDataBytes: 20 * GiB,
  diskRetryAfterS: 300,
  bodiesInFlight: 32,
  busyRetryAfterS: 5,
  idleDays: 180,
  diskCacheMs: 30_000,
  headersTimeoutMs: 15_000,
  requestTimeoutMs: 120_000,
};

export type Bucket = { readonly tokens: number; readonly at: number };

/** `retryAfterS` is 0 when a token was spent, else the whole seconds until one is there. */
export type Taken = { readonly bucket: Bucket; readonly retryAfterS: number };

/** Spends one token from `bucket` (undefined is a new, full one) after refilling it to `now` (ms). */
export function take(bucket: Bucket | undefined, rate: Rate, now: number): Taken {
  const tokens = refilled(bucket, rate, now);
  if (tokens >= 1) return { bucket: { tokens: tokens - 1, at: now }, retryAfterS: 0 };
  return { bucket: { tokens, at: now }, retryAfterS: Math.ceil((1 - tokens) / rate.perSecond) };
}

/** Whether `bucket` is back to `burst` at `now`, so forgetting it changes nothing. */
export function isFull(bucket: Bucket, rate: Rate, now: number): boolean {
  return refilled(bucket, rate, now) >= rate.burst;
}

function refilled(bucket: Bucket | undefined, rate: Rate, now: number): number {
  if (bucket === undefined) return rate.burst;
  return Math.min(rate.burst, bucket.tokens + ((now - bucket.at) / 1000) * rate.perSecond);
}
