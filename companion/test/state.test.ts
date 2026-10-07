import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Setting, StagedChange } from '../../extension/src/profile-mode.ts';
import { mergeStaged, overlay } from '../src/state.ts';
import { item } from './fixture.ts';

const pref = (value: Setting['value']): Setting => ({ kind: 'pref', value });
const change = (id: string, before: Setting | null, after: Setting | null): StagedChange<Setting> => ({ id: item(id), before, after });

test('overlay shows `after` only where the file still holds `before`', () => {
  const file = new Map([
    [item('a'), pref(1)],
    [item('b'), pref('user-edited')],
    [item('c'), pref(true)],
  ]);
  const view = overlay(file, [
    change('a', pref(1), pref(2)), // still holds: presented
    change('b', pref('old'), pref('new')), // user changed it: the file wins
    change('c', pref(true), null), // removal
    change('d', null, pref([1])), // addition to an absent pref
    change('e', pref(0), pref(9)), // expected present, but absent: the file wins
  ]);
  assert.deepEqual(Object.fromEntries([...view].map(([id, s]) => [id, s.value])), { a: 2, b: 'user-edited', d: [1] });
});

test('stage merge keeps the first before, takes the latest after, and drops a round trip', () => {
  const merged = mergeStaged(
    [change('a', pref(1), pref(2)), change('b', null, pref('x'))],
    [change('a', pref(2), pref(3)), change('b', pref('x'), null), change('c', pref(5), pref(5))],
  );
  assert.deepEqual(merged, [change('a', pref(1), pref(3))]);
});
