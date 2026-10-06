// When a cycle runs, how a trigger survives the worker dying, and how two contexts avoid running one at once.
// The engine knows none of this. From candidate 3, with user intents (Asks) added as durable counters.
//
// MV3 facts this rests on (Chrome 120+; verify on Helium 154):
//   - An event listener must be registered synchronously at top level, or the waking event is dropped.
//   - A setTimeout dies with the worker. A chrome.alarms alarm wakes a dead worker; its minimum delay is 30 s.
//   - One event may run about 5 minutes. Whether fetch, IndexedDB, or File System Access calls reset the 30 s
//     idle timer is contested (candidates 2 and 3 disagree). keepAlive pings a chrome.* API, which does, so the
//     question stops mattering.
//   - navigator.locks works in the worker and in pages. The browser releases a lock its holder's context lost.
import type { Asks, Budget } from './ports.ts';

export type Trigger =
  | 'install'
  | 'startup'
  | 'poll'
  | 'resume'
  | 'setup'
  | 'manual'
  | 'bookmarks'
  | 'history-removed'
  | 'apply-deletions';

/** Latency a trigger may wait to coalesce a burst. The `resume` alarm is armed at max(this, 30 s) as the backstop. */
export const DEBOUNCE_MS = {
  install: 0,
  startup: 0,
  poll: 0,
  resume: 0,
  setup: 0,
  manual: 0,
  bookmarks: 5_000,
  'history-removed': 5_000,
  'apply-deletions': 0,
} as const satisfies Record<Trigger, number>;

/** Triggers that carry a user intent. Bumped in the same transaction as `requested`. */
export const ASK_OF = {
  'history-removed': 'rederiveHistory',
  'apply-deletions': 'applyDeletions',
} as const satisfies Partial<Record<Trigger, keyof Asks>>;

export const POLL_MINUTES = 5;
/** Four of the five minutes one event may run, shared by every cycle in one wake. */
export const BUDGET_MS = 240_000;
export const CYCLE_LOCK = 'helium-sync';

/** Level-triggered: work is wanted while `requested > completed`, so a lost event can never lose work. */
export type Intent = {
  readonly requested: number;
  readonly completed: number;
  readonly failures: number;
  readonly asks: Asks;
};

/** IndexedDB `kv/intent` (local.ts). Each method is one readwrite transaction. */
export interface IntentStore {
  /** requested + 1, plus the trigger's ask if it has one. */
  request(trigger: Trigger): Promise<void>;
  read(): Promise<Intent>;
  /** completed = max(completed, upTo); failures = 0. */
  complete(upTo: number): Promise<void>;
  /** failures + 1. Returns the new count, which sets the backoff. */
  fail(): Promise<number>;
}

/** The one-shot `resume` alarm. */
export interface Wake {
  /** Arms `resume` unless one is already due sooner. Rounds up to 30 s. */
  arm(delayMs: number): Promise<void>;
  disarm(): Promise<void>;
}

export type CycleResult =
  | { readonly kind: 'complete' }
  /** The budget ran out with work left. */
  | { readonly kind: 'partial' }
  /** A bug or an unreadable store. Backs off; the popup shows the message. */
  | { readonly kind: 'failed'; readonly message: string };

export type SchedulerDeps = {
  readonly intents: IntentStore;
  readonly wake: Wake;
  /** Builds the engine from IndexedDB, runs one cycle, writes the report. Wired in background.ts. */
  readonly runCycle: (budget: Budget, asks: Asks) => Promise<CycleResult>;
  readonly now: () => number;
};

export interface Scheduler {
  /**
   * Fire and forget, safe from any listener. Persists the intent first, then arms a debounce timer for latency
   * and the `resume` alarm as the durable backstop, so a worker that dies during the debounce still drains.
   */
  request(trigger: Trigger): void;
}

export function createScheduler(_deps: SchedulerDeps): Scheduler {
  throw new Error('not implemented');
}

/*
 * drain(): the only place cycles run. Called when a debounce timer fires or an alarm wakes the worker.
 *
 *   budget = deadline(now + BUDGET_MS)
 *   navigator.locks.request(CYCLE_LOCK, { ifAvailable: true }, async (lock) => {
 *     if (!lock) return                       // another context drains; it re-reads `requested` before it releases
 *     stop = keepAlive()
 *     try loop:
 *       { requested, completed, asks } = intents.read()
 *       requested == completed -> wake.disarm(); return
 *       wake.arm(30 s)                        // dead-man's switch: if we are killed below, this wakes us
 *       switch (runCycle(budget, asks)).kind  // exhaustive
 *         complete -> intents.complete(requested)          // a request that arrived mid-cycle stays pending and loops
 *         partial  -> wake.arm(0); return                  // continue in a fresh event with a fresh budget
 *         failed   -> wake.arm(backoff(intents.fail())); return    // 30 s, 1, 2, 4 ... 15 min
 *       budget.expired() -> wake.arm(0); return
 *     finally stop()
 *   })
 */

/** Wait-mode lock for the RPCs that touch engine state outside a drain: start, preview, set-history, forget. */
export function withCycleLock<T>(_fn: () => Promise<T>): Promise<T> {
  throw new Error('not implemented');
}

export function deadline(_atMs: number, _now: () => number): Budget {
  throw new Error('not implemented');
}

/** Calls chrome.runtime.getPlatformInfo() every 20 s so the idle timer never fires mid-cycle. Returns stop. */
export function keepAlive(): () => void {
  throw new Error('not implemented');
}
