// When a cycle runs, how a trigger survives the worker dying, and how two contexts avoid running one at once.
// The engine knows none of this.
//
// MV3 facts this rests on (Chrome 120+; verify on Helium 154):
//   - An event listener must be registered synchronously at top level, or the waking event is dropped.
//   - A setTimeout dies with the worker. A chrome.alarms alarm wakes a dead worker; its minimum delay is 30 s.
//   - One event may run about 5 minutes. Whether fetch, IndexedDB, or File System Access calls reset the 30 s
//     idle timer is contested. keepAlive pings a chrome.* API, which does, so the question stops mattering.
//   - navigator.locks works in the worker and in pages. The browser releases a lock its holder's context lost.
//
// Every browser dependency (IndexedDB, chrome.alarms, navigator.locks, timers, the keep-alive ping) enters
// through a small interface, so the whole scheduler runs in a Node test.
import type { Asks, Budget } from './ports.ts';

export type Trigger = 'install' | 'startup' | 'poll' | 'resume' | 'setup' | 'manual' | 'bookmarks' | 'reading-list' | 'extensions' | 'history-removed' | 'apply-deletions';

/** Latency a trigger may wait to coalesce a burst. The `resume` alarm is armed at max(this, 30 s) as the backstop. */
export const DEBOUNCE_MS = {
  install: 0,
  startup: 0,
  poll: 0,
  resume: 0,
  setup: 0,
  manual: 0,
  bookmarks: 5_000,
  'reading-list': 5_000,
  extensions: 5_000,
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
export const ALARM_MIN_MS = 30_000;
export const KEEP_ALIVE_MS = 20_000;
const BACKOFF_MAX_MS = 15 * 60_000;

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

/** navigator.locks, narrowed to the two calls made here. */
export interface Locks {
  /** `ifAvailable`: `fn(false)` runs at once when another context holds the lock. */
  request<T>(name: string, mode: { readonly ifAvailable: boolean }, fn: (held: boolean) => Promise<T>): Promise<T>;
}

export interface Timers {
  set(fn: () => void, delayMs: number): TimerHandle;
  clear(handle: TimerHandle): void;
}
export type TimerHandle = { readonly id: number };

export type CycleResult =
  | { readonly kind: 'complete' }
  /** The budget ran out with work left. */
  | { readonly kind: 'partial' }
  /** A bug or an unreadable store. Backs off; the popup shows the message. */
  | { readonly kind: 'failed'; readonly message: string };

export type SchedulerDeps = {
  readonly intents: IntentStore;
  readonly wake: Wake;
  readonly locks: Locks;
  readonly timers: Timers;
  /** chrome.runtime.getPlatformInfo in the worker. Any chrome.* call resets the idle timer. */
  readonly ping: () => void;
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
  /** The drain, exposed so an alarm or a test can run it directly. Resolves when this context is done. */
  drain(): Promise<void>;
}

/** 30 s, 1, 2, 4 ... 15 min. */
export function backoff(failures: number): number {
  return Math.min(BACKOFF_MAX_MS, ALARM_MIN_MS * 2 ** Math.max(0, failures - 1));
}

export function deadline(atMs: number, now: () => number): Budget {
  return { expired: () => now() >= atMs };
}

/** Pings a chrome.* API every 20 s so the idle timer never fires mid-cycle. Returns stop. */
export function keepAlive(ping: () => void, timers: Timers): () => void {
  let handle: TimerHandle | null = null;
  const tick = () => {
    ping();
    handle = timers.set(tick, KEEP_ALIVE_MS);
  };
  handle = timers.set(tick, KEEP_ALIVE_MS);
  return () => {
    if (handle !== null) timers.clear(handle);
    handle = null;
  };
}

/** Wait-mode lock for the RPCs that touch engine state outside a drain: start, preview, set-history, forget. */
export function withCycleLock<T>(locks: Locks, fn: () => Promise<T>): Promise<T> {
  return locks.request(CYCLE_LOCK, { ifAvailable: false }, fn);
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  let debounce: TimerHandle | null = null;

  async function drain(): Promise<void> {
    const budget = deadline(deps.now() + BUDGET_MS, deps.now);
    await deps.locks.request(CYCLE_LOCK, { ifAvailable: true }, async (held) => {
      if (!held) return; // another context drains; it re-reads `requested` before it releases
      const stop = keepAlive(deps.ping, deps.timers);
      try {
        while (true) {
          const { requested, completed, asks } = await deps.intents.read();
          if (requested <= completed) {
            await deps.wake.disarm();
            return;
          }
          await deps.wake.arm(ALARM_MIN_MS); // dead-man's switch: if we are killed below, this wakes us
          const result = await deps.runCycle(budget, asks);
          switch (result.kind) {
            case 'complete':
              await deps.intents.complete(requested); // a request that arrived mid-cycle stays pending and loops
              break;
            case 'partial':
              await deps.wake.arm(0); // continue in a fresh event with a fresh budget
              return;
            case 'failed':
              await deps.wake.arm(backoff(await deps.intents.fail()));
              return;
            default: {
              const unreachable: never = result;
              return unreachable;
            }
          }
          if (budget.expired()) {
            await deps.wake.arm(0);
            return;
          }
        }
      } finally {
        stop();
      }
    });
  }

  return {
    request(trigger) {
      void (async () => {
        await deps.intents.request(trigger);
        const delay = DEBOUNCE_MS[trigger];
        await deps.wake.arm(Math.max(delay, ALARM_MIN_MS));
        if (debounce !== null) deps.timers.clear(debounce);
        debounce = deps.timers.set(() => {
          debounce = null;
          void drain();
        }, delay);
      })();
    },
    drain,
  };
}
