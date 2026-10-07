import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HostRequest, SearchEngine } from '../../extension/src/profile-mode.ts';
import { frame, readFrames } from '../src/framing.ts';
import { serve, type HostContext } from '../src/host.ts';
import { ADDRESS, DOCS, docsEngine, item, makeFixture, patAddress, type Fixture } from './fixture.ts';

/** Run the host over framed requests; returns the replies and how often it woke the helper. */
async function exchange(fixture: Fixture, requests: readonly unknown[]): Promise<{ replies: unknown[]; wakes: number }> {
  let wakes = 0;
  const ctx: HostContext = { home: fixture.home, userDataDir: fixture.userDataDir, wakeHelper: () => void wakes++, log: () => {} };
  const out: Buffer[] = [];
  await serve(ctx, [Buffer.concat(requests.map(frame))], async (bytes) => void out.push(bytes));
  const replies: unknown[] = [];
  for await (const reply of readFrames([Buffer.concat(out)])) replies.push(reply);
  return { replies, wakes };
}

const SYNCED = item('22222222-2222-4222-8222-222222222222');
const renamed: SearchEngine = { ...docsEngine, name: 'Docs (renamed)' };

test('hello lists the profiles from Local State', async () => {
  const fixture = makeFixture();
  const { replies } = await exchange(fixture, [{ kind: 'hello' }]);
  assert.deepEqual(replies, [
    { kind: 'hello', protocol: 1, version: '0.1.0', userDataDir: fixture.userDataDir, profiles: [{ dir: 'Default', name: 'Person 1' }, { dir: 'Profile 1', name: 'Work' }] },
  ]);
});

test('read maps bound guids to synced ids and overlays staged changes; stage wakes the helper', async () => {
  const fixture = makeFixture();
  const requests: HostRequest[] = [
    { kind: 'bind', profile: 'Default', type: 'search-engines', aliases: [[item(DOCS), SYNCED]] },
    {
      kind: 'stage',
      profile: 'Default',
      changes: {
        settings: [{ id: item('download.prompt_for_download'), before: { kind: 'pref', value: false }, after: { kind: 'pref', value: true } }],
        'search-engines': [{ id: SYNCED, before: docsEngine, after: renamed }],
        addresses: [{ id: item(ADDRESS), before: patAddress, after: null }],
      },
    },
    { kind: 'read', profile: 'Default' },
  ];
  const { replies, wakes } = await exchange(fixture, requests);
  assert.deepEqual(replies.slice(0, 2), [{ kind: 'ok', pending: 0 }, { kind: 'ok', pending: 3 }]);
  assert.equal(wakes, 1);
  assert.deepEqual(replies[2], {
    kind: 'state',
    webData: 'ok',
    pending: 3,
    state: {
      settings: [
        ['download.prompt_for_download', { kind: 'pref', value: true }],
        ['intl.accept_languages', { kind: 'pref', value: 'en-US,en' }],
        ['spellcheck.dictionaries', { kind: 'pref', value: ['en-GB'] }],
        ['webkit.webprefs.default_font_size', { kind: 'pref', value: 18 }],
        ['webkit.webprefs.default_fixed_font_size', { kind: 'pref', value: 15 }],
        ['helium.browser.show_back_button', { kind: 'pref', value: false }],
        ['helium.browser.tabs.vertical', { kind: 'pref', value: true }],
        ['profile.default_content_setting_values.cookies', { kind: 'pref', value: 4 }],
      ],
      // Built-ins and the default engine are not synced; Docs shows under its synced id, renamed.
      'search-engines': [[SYNCED, renamed]],
      addresses: [],
    },
  });
});

test('stage rejects a path outside the allowlist, all or nothing', async () => {
  const fixture = makeFixture();
  const { replies, wakes } = await exchange(fixture, [
    {
      kind: 'stage',
      profile: 'Default',
      changes: {
        settings: [
          { id: 'download.prompt_for_download', before: null, after: { kind: 'pref', value: true } },
          { id: 'homepage', before: null, after: { kind: 'pref', value: 'https://evil.test' } },
        ],
      },
    },
    { kind: 'read', profile: '../elsewhere' },
  ]);
  assert.deepEqual(replies[0], { kind: 'error', message: 'stage: a change does not parse' });
  assert.deepEqual(replies[1], { kind: 'error', message: 'not a profile directory name: ../elsewhere' });
  assert.equal(wakes, 0);
});
