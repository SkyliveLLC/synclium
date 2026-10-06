// The scheduler against fake browser primitives: durable intents, debounce plus resume alarm, the lock, the
// per-wake budget, and keepAlive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALARM_MIN_MS, ASK_OF, BUDGET_MS, KEEP_ALIVE_MS, backoff, createScheduler, deadline, keepAlive, withCycleLock, type CycleResult, type Intent, type IntentStore, type Locks, type Scheduler, type TimerHandle, type Timers, type Trigger, type Wake } from '../src/scheduler.ts';
import { noAsks, type Asks, type Budget } from '../src/ports.ts';

function memoryIntents(): IntentStore & { readonly intent: () => Intent } {
  let intent: Intent = { requested: 0, completed: 0, failures: 0, asks: noAsks };
  return {
    intent: () => intent,
    request: async (trigger: Trigger) => {
      const ask = trigger in ASK_OF ? ASK_OF[trigger as keyof typeof ASK_OF] : null;
      intent = { ...intent, requested: intent.requested + 1, asks: ask === null ? intent.asks : { ...intent.asks, [ask]: intent.asks[ask] + 1 } };
    },
    read: async () => intent,
    complete: async (upTo) => {
      intent = { ...intent, completed: Math.max(intent.completed, upTo), failures: 0 };
    },
    fail: async () => {
      intent = { ...intent, failures: intent.failures + 1 };
      return intent.failures;
    },
  };
}

function fakeWake(): Wake & { readonly armed: number[]; disarmed: number } {
  const wake = {
    armed: [] as number[],
    disarmed: 0,
    arm: async (delayMs: number) => {
      wake.armed.push(delayMs);
    },
    disarm: async () => {
      wake.disarmed++;
    },
  };
  return wake;
}

function fakeLocks(): Locks & { busy: boolean } {
  const locks = {
    busy: false,
    async request<T>(_name: string, mode: { readonly ifAvailable: boolean }, fn: (held: boolean) => Promise<T>): Promise<T> {
      if (locks.busy && mode.ifAvailable) return fn(false);
      locks.busy = true;
      try {
        return await fn(true);
      } finally {
        locks.busy = false;
      }
    },
  };
  return locks;
}

/** Timers fire only when the test says so. */
function fakeTimers(): Timers & { fire(): Promise<void>; readonly pending: () => number } {
  const queue = new Map<number, { fn: () => void; delay: number }>();
  let next = 1;
  return {
    pending: () => queue.size,
    set: (fn, delay): TimerHandle => {
      const id = next++;
      queue.set(id, { fn, delay });
      return { id };
    },
    clear: (handle) => {
      queue.delete(handle.id);
    },
    async fire() {
      const first = [...queue.entries()].sort((a, b) => a[1].delay - b[1].delay)[0];
      if (first === undefined) return;
      queue.delete(first[0]);
      first[1].fn();
      await settle();
    },
  };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Fire the due timer, then wait until the drain it started released the lock. */
async function fireAndDrain(r: Rig): Promise<void> {
  await r.timers.fire();
  for (let i = 0; i < 50 && r.locks.busy; i++) await settle();
}

type Rig = {
  scheduler: Scheduler;
  intents: ReturnType<typeof memoryIntents>;
  wake: ReturnType<typeof fakeWake>;
  locks: ReturnType<typeof fakeLocks>;
  timers: ReturnType<typeof fakeTimers>;
  cycles: { budget: Budget; asks: Asks }[];
  now: { t: number };
  pings: { n: number };
};

function rig(runCycle: (rig: Rig, budget: Budget, asks: Asks) => Promise<CycleResult>): Rig {
  const intents = memoryIntents();
  const wake = fakeWake();
  const locks = fakeLocks();
  const timers = fakeTimers();
  const now = { t: 1_000_000 };
  const pings = { n: 0 };
  const cycles: Rig['cycles'] = [];
  const r: Rig = {
    intents,
    wake,
    locks,
    timers,
    cycles,
    now,
    pings,
    scheduler: createScheduler({
      intents,
      wake,
      locks,
      timers,
      ping: () => pings.n++,
      now: () => now.t,
      runCycle: async (budget, asks) => {
        cycles.push({ budget, asks });
        return runCycle(r, budget, asks);
      },
    }),
  };
  return r;
}

const complete = async (): Promise<CycleResult> => ({ kind: 'complete' });

test('a request is persisted and the resume alarm armed before any timer fires, so a dead worker still drains', async () => {
  const r = rig(complete);
  r.scheduler.request('bookmarks');
  await settle();
  assert.equal(r.intents.intent().requested, 1);
  assert.deepEqual(r.wake.armed, [ALARM_MIN_MS], 'the backstop alarm is armed at the 30 s minimum');
  assert.equal(r.cycles.length, 0, 'no cycle until the debounce fires');
  assert.equal(r.timers.pending(), 1);
});

test('a burst of bookmark events coalesces into one cycle that completes every request', async () => {
  const r = rig(complete);
  for (let i = 0; i < 3; i++) r.scheduler.request('bookmarks');
  await settle();
  assert.equal(r.timers.pending(), 1, 'earlier debounce timers were cleared');
  await r.timers.fire();
  assert.equal(r.cycles.length, 1);
  assert.equal(r.intents.intent().completed, 3);
  assert.equal(r.wake.disarmed, 1, 'nothing pending: the resume alarm is disarmed');
});

test('a request that arrives mid-cycle is not swallowed: the drain loops once more', async () => {
  const r = rig(async (rig) => {
    if (rig.cycles.length === 1) {
      rig.scheduler.request('manual');
      await settle();
    }
    return { kind: 'complete' };
  });
  r.scheduler.request('poll');
  await settle();
  await fireAndDrain(r);
  assert.equal(r.cycles.length, 2, 'the mid-cycle request ran its own cycle');
  assert.equal(r.intents.intent().completed, 2);
});

test('a partial cycle re-arms resume immediately and leaves the intent open', async () => {
  const r = rig(async () => ({ kind: 'partial' }));
  r.scheduler.request('poll');
  await settle();
  await r.timers.fire();
  assert.equal(r.cycles.length, 1);
  assert.equal(r.wake.armed.at(-1), 0, 'continue in a fresh event');
  assert.equal(r.intents.intent().completed, 0, 'the request stays pending');
  assert.equal(r.wake.disarmed, 0);
});

test('failures back off 30 s, 1 min, 2 min and the intent stays pending', async () => {
  const r = rig(async () => ({ kind: 'failed', message: 'boom' }));
  const delays: number[] = [];
  for (let i = 0; i < 3; i++) {
    r.scheduler.request('poll');
    await settle();
    await r.timers.fire();
    delays.push(r.wake.armed.at(-1) ?? -1);
  }
  assert.deepEqual(delays, [30_000, 60_000, 120_000]);
  assert.equal(r.intents.intent().completed, 0);
  assert.equal(backoff(10), 15 * 60_000, 'capped at 15 minutes');
});

test('a drain while another context holds the lock runs nothing', async () => {
  const r = rig(complete);
  r.locks.busy = true;
  r.scheduler.request('poll');
  await settle();
  await r.timers.fire();
  assert.equal(r.cycles.length, 0);
  assert.equal(r.intents.intent().requested, 1, 'the request is still recorded for the lock holder to pick up');
});

test('history-removed and apply-deletions bump their durable asks with the request and reach the cycle', async () => {
  const r = rig(complete);
  r.scheduler.request('history-removed');
  r.scheduler.request('apply-deletions');
  r.scheduler.request('history-removed');
  await settle();
  assert.deepEqual(r.intents.intent().asks, { rederiveHistory: 2, applyDeletions: 1 });
  await r.timers.fire();
  assert.deepEqual(r.cycles[0]?.asks, { rederiveHistory: 2, applyDeletions: 1 });
});

test('the budget expires at the deadline and a cycle that uses it all re-arms resume instead of looping', async () => {
  const r = rig(async (rig) => {
    rig.now.t += BUDGET_MS;
    rig.scheduler.request('manual');
    await settle();
    return { kind: 'complete' };
  });
  r.scheduler.request('poll');
  await settle();
  await fireAndDrain(r);
  assert.equal(r.cycles.length, 1, 'the second request waits for a fresh budget');
  assert.equal(r.wake.armed.at(-1), 0);
  const budget = deadline(100, () => 99);
  assert.equal(budget.expired(), false);
  assert.equal(deadline(100, () => 100).expired(), true);
});

test('keepAlive pings on its interval while a cycle runs and stops with it', async () => {
  const timers = fakeTimers();
  let pings = 0;
  const stop = keepAlive(() => pings++, timers);
  await timers.fire();
  await timers.fire();
  assert.equal(pings, 2);
  stop();
  await timers.fire();
  assert.equal(pings, 2, 'no ping after stop');
  assert.equal(timers.pending(), 0);
  void KEEP_ALIVE_MS;
});

test('withCycleLock waits for the drain lock instead of skipping', async () => {
  const locks = fakeLocks();
  let ran = false;
  await withCycleLock(locks, async () => {
    ran = true;
    assert.equal(locks.busy, true);
  });
  assert.equal(ran, true);
  assert.equal(locks.busy, false);
});
