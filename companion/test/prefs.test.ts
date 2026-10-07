import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readSettings, withSetting } from '../src/prefs.ts';
import { item, PREFERENCES } from './fixture.ts';

test('reads exact allowlisted paths and every leaf under a prefix entry, nothing else', () => {
  const settings = readSettings(PREFERENCES);
  assert.deepEqual(Object.fromEntries([...settings].map(([path, setting]) => [path, setting.value])), {
    'download.prompt_for_download': false,
    'intl.accept_languages': 'en-US,en',
    'spellcheck.dictionaries': ['en-GB'],
    'webkit.webprefs.default_font_size': 18,
    'webkit.webprefs.default_fixed_font_size': 15,
    'helium.browser.show_back_button': false,
    'helium.browser.tabs.vertical': true,
    'profile.default_content_setting_values.cookies': 4,
  });
});

test('setting and removing a pref leaves every other key as it was', () => {
  const set = withSetting(PREFERENCES, item('helium.browser.tabs.vertical'), false);
  assert.ok(set !== null);
  assert.deepEqual(set, { ...PREFERENCES, helium: { ...PREFERENCES.helium, browser: { ...PREFERENCES.helium.browser, tabs: { vertical: false } } } });

  const removed = withSetting(PREFERENCES, item('download.prompt_for_download'), undefined);
  assert.deepEqual(removed, { ...PREFERENCES, download: { default_directory: '/Users/someone/Downloads' } });

  const created = withSetting(PREFERENCES, item('bookmark_bar.show_on_all_tabs'), true);
  assert.deepEqual(created, { ...PREFERENCES, bookmark_bar: { show_on_all_tabs: true } });
});

test('refuses paths outside the allowlist and writes that would replace a dict under a prefix', () => {
  assert.equal(withSetting(PREFERENCES, item('browser.window_placement.left'), 0), null);
  assert.equal(withSetting(PREFERENCES, item('helium.browser.tabs'), true), null);
  assert.equal(withSetting(PREFERENCES, item('intl.accept_languages.x'), 1), null);
});
