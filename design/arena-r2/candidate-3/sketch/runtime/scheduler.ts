// The part of MV3 the engine must not know about: when a cycle runs, how a trigger survives the worker dying,
// and how two contexts avoid running one at once. The engine is stateless between calls, so everything durable
// here is two counters.
//
// Facts this is built on (Chrome 120+, verify on Helium 154):
//   - The worker is killed after 30 s without an event or extension API call, or when one event runs past 5 minutes.
//   - Any chrome.* API call resets the 30 s timer. IndexedDB, FSA, and fetch do not.
//   - A setTimeout does not survive termination. A chrome.alarms alarm does (it wakes a dead worker), but the
//     minimum delay is 30 s and alarms may be cleared by a browser restart, so they are re-created on every wake.
//   - An event listener must be registered synchronously at top level, or the waking event is dropped.
//   - navigator.locks works in the worker and in pages. A lock held by a dead context is released by the browser.
import type { Budget } from '../ports.ts';

/** Why a cycle was asked for. Only the debounce differs. */
export type Trigger = 'install' | 'startup' | 'poll' | 'resume' | 'bookmarks' | 'history' | 'settings' | 'manual';

/** Latency a trigger may wait to coalesce a burst. History is the noisy one: one page load is several events. */
export const DEBOUNCE_MS = {
  install: 0, startup: 0, poll: 0, resume: 0, manual: 0, settings: 1_000, bookmarks: 5_000, history: 60_000,
} as const satisfies Record<Trigger, number>;

export const POLL_MINUTES = 2; // chrome.alarms periodic: sees peer files change. FSA has no change events.
export const EVENT_CAP_MS = 240_000; // 4 of the 5 minutes Chrome gives one event
export const CYCLE_LOCK = 'helium-sync:cycle';

/** Level-triggered: "something is wanted" is `requested > completed`, so a lost event can never lose work. */
export interface Counters {
  /** Atomic read-modify-write in IndexedDB. Returns the new `requested`. */
  request(): Promise<number>;
  read(): Promise<{ readonly requested: number; readonly completed: number; readonly failures: number }>;
  /** completed = max(completed, upTo), failures = 0 */
  complete(upTo: number): Promise<void>;
  /** failures + 1. Returns the new count, which sets the backoff. */
  fail(): Promise<number>;
}

/** The one-shot alarm that wakes a dead worker. */
export interface Wake {
  /** Creates `resume` unless one is already due sooner. Never later than an existing one. */
  arm(delayMs: number): Promise<void>;
  disarm(): Promise<void>;
}

export type CycleResult =
  | { readonly kind: 'complete' }
  /** Budget or write quota ran out, work remains. */
  | { readonly kind: 'partial'; readonly retryInMs: number }
  /** A bug or an unreadable store. Backs off, and the popup shows `lastError`. */
  | { readonly kind: 'failed'; readonly message: string };

export type SchedulerDeps = {
  readonly counters: Counters;
  readonly wake: Wake;
  /** Reads settings, builds the engine, runs one bounded cycle, publishes `status`. Wired in worker.ts. */
  readonly runCycle: (budget: Budget) => Promise<CycleResult>;
  readonly now: () => number;
};

export interface Scheduler {
  /**
   * Fire and forget, safe from any listener. Persists the intent first, then arms a debounce timer for latency
   * and the `resume` alarm as the durable backstop, so a worker that dies during the debounce is woken to finish it.
   */
  request(trigger: Trigger): void;
}

export function createScheduler(_deps: SchedulerDeps): Scheduler {
  throw new Error('not implemented');
}

/*
 * drain(), the only place cycles run. Called when a debounce timer fires or an alarm wakes the worker.
 *
 *   budget = deadline(now + EVENT_CAP_MS)                       // shared by every loop pass in this wake
 *   navigator.locks.request(CYCLE_LOCK, { ifAvailable: true }, async (lock) => {
 *     if (!lock) return                                         // another context is draining. It re-checks `pending` before it
 *                                                               // releases, so our already-persisted request is not lost.
 *     stopKeepAlive = keepAlive()                               // setInterval 20 s calling chrome.runtime.getPlatformInfo()
 *     try {
 *       while (true) {
 *         { requested, completed } = counters.read()
 *         if (requested == completed) break                     // nothing wanted
 *         wake.arm(30 s)                                        // dead-man's switch: if we are killed below, this wakes us
 *         r = runCycle(budget)
 *         switch r.kind
 *           complete  counters.complete(requested)              // upTo = what we saw BEFORE the cycle: a request that
 *                                                               // arrived during the cycle stays pending and loops
 *           partial   wake.arm(r.retryInMs); return             // budget gone or quota. Continue in a new event.
 *           failed    n = counters.fail(); wake.arm(backoff(n)); return   // 30 s, 1, 2, 4 ... capped at 15 min
 *         if budget.expired(): wake.arm(0); return
 *       }
 *       wake.disarm()
 *     } finally { stopKeepAlive() }
 *   })
 *
 * Why this survives termination: the intent (`requested`) is durable before anything else happens, `completed`
 * advances only after a whole cycle, and the engine is idempotent. A kill anywhere leaves requested > completed
 * and an armed alarm, so the next wake reruns the cycle from the top and converges.
 * Two live contexts cannot both cycle (Web Lock). If one dies holding it, the browser releases the lock.
 */

/** Wall-clock deadline as a Budget. The engine polls it between shards. */
export function deadline(_atMs: number, _now: () => number): Budget {
  throw new Error('not implemented');
}

/** Pings a cheap extension API on an interval so the 30 s idle timer never fires mid-cycle. Returns the stop function. */
export function keepAlive(): () => void {
  throw new Error('not implemented');
}
