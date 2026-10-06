// Crash convergence and budget convergence. One scenario with bookmarks and history on two devices runs clean
// once, then once per kill point (every port call, killed before and after it) and once per budget size
// (expiring after every k units). Every run must end in the same state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, Crasher, worldSnapshot, expireAfter, type Device } from './support/harness.ts';
import { ground, idOf, urlTitle, BAR } from './support/ground.ts';
import { visitsOver } from './support/fake-history.ts';
import type { Budget } from '../src/ports.ts';

type Run = { readonly crasher?: Crasher; readonly budgets?: () => Budget };

/** X publishes a profile with history, Y joins with a different one, X edits, both sync. */
async function scenario(run: Run): Promise<World> {
  const world = new World('icloud');
  const opts = run.crasher === undefined ? {} : { crasher: run.crasher };
  const xTree = ground(12);
  const yTree = ground(12);
  yTree.remove(idOf(yTree, urlTitle(3)));
  yTree.add(BAR, 0, { title: 'only-y', url: 'https://y.example/only' });
  const x = world.add('X', { browser: xTree, ...opts });
  const y = world.add('Y', { browser: yTree, ...opts });
  await x.setup();
  await y.setup();
  for (const v of visitsOver(world.clock.now, 2, 3, 'x.example')) x.history.add(v);
  for (const v of visitsOver(world.clock.now, 1, 2, 'y.example')) y.history.add(v);
  const step = async (d: Device) => {
    world.clock.tick(1000);
    await d.cycle(run.budgets);
  };
  await step(x);
  await step(y);
  await step(x);
  x.browser.rename(idOf(x.browser, urlTitle(5)), 'renamed-by-x');
  x.browser.add(BAR, 2, { title: 'added-by-x', url: 'https://x.example/added' });
  x.browser.remove(idOf(x.browser, urlTitle(7)));
  x.history.add({ url: 'https://x.example/late', title: 'late', t: world.clock.now - 10 });
  await step(x);
  await step(y);
  await step(x);
  await step(y);
  return world;
}

test('crash convergence: killing any port call, before or after it runs, ends in the clean run\'s state', async () => {
  const counter = new Crasher(Infinity, 'before');
  const clean = await scenario({ crasher: counter });
  const expected = await worldSnapshot(clean);
  const total = counter.calls;
  assert.ok(total > 50, `the scenario makes enough port calls to be worth sweeping (${total})`);
  const x = clean.dev('X');
  assert.equal(x.browser.find('renamed-by-x').length, 1);
  assert.equal(clean.dev('Y').browser.find('added-by-x').length, 1, 'clean run propagated X\'s add');
  assert.equal(clean.dev('Y').browser.find(urlTitle(7)).length, 0, 'clean run propagated X\'s remove');
  assert.equal(clean.dev('Y').sink.visitsFrom(x.device).length, 7, 'clean run indexed X\'s 7 visits on Y');

  let killed = 0;
  for (const when of ['before', 'after'] as const) {
    for (let at = 1; at <= total; at++) {
      const crasher = new Crasher(at, when);
      const world = await scenario({ crasher });
      if (!crasher.fired) continue;
      killed++;
      const actual = await worldSnapshot(world);
      assert.equal(actual, expected, `run killed ${when} call ${at} ended in a different state`);
    }
  }
  assert.ok(killed >= total, `every kill point fired at least once (${killed} of ${total * 2})`);
});

// k starts at 2: the incremental history scan is a mandatory unit every wake, so a wake that affords one unit
// can never reach the derive walk or a pull, and the scenario would not complete.
test('budget convergence: a budget that expires after every k units ends in the unbounded run\'s state', async () => {
  const clean = await scenario({});
  const expected = await worldSnapshot(clean);
  for (let k = 2; k <= 12; k++) {
    let cycles = 0;
    const world = await scenario({
      budgets: () => {
        cycles++;
        return expireAfter(k);
      },
    });
    assert.equal(await worldSnapshot(world), expected, `budget of ${k} units ended in a different state`);
    if (k === 2) assert.ok(cycles > 20, `a two-unit budget needs many wakes (${cycles})`);
  }
});
