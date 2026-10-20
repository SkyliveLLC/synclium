import assert from 'node:assert/strict';
import { test } from 'node:test';
import { companionHome, defaultUserDataDir, userDataDirFromCommand, type Place } from '../src/paths.ts';

const mac: Place = { os: 'darwin', env: {}, home: '/Users/sam' };
const linux: Place = { os: 'linux', env: {}, home: '/home/sam' };
const windows: Place = { os: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\sam\\AppData\\Local' }, home: 'C:\\Users\\sam' };

test("Helium's default user data dir and the companion home, per system", () => {
  assert.equal(defaultUserDataDir(mac), '/Users/sam/Library/Application Support/net.imput.helium');
  assert.equal(companionHome(mac), '/Users/sam/Library/Application Support/helium-sync-companion');
  assert.equal(defaultUserDataDir(linux), '/home/sam/.config/net.imput.helium');
  assert.equal(companionHome(linux), '/home/sam/.local/share/helium-sync-companion');
  assert.equal(defaultUserDataDir(windows), 'C:\\Users\\sam\\AppData\\Local\\imput\\Helium\\User Data');
  assert.equal(companionHome(windows), 'C:\\Users\\sam\\AppData\\Local\\helium-sync-companion');
});

test('XDG dirs and the companion home override are honored', () => {
  const xdg: Place = { ...linux, env: { XDG_CONFIG_HOME: '/cfg', XDG_DATA_HOME: '/data' } };
  assert.equal(defaultUserDataDir(xdg), '/cfg/net.imput.helium');
  assert.equal(companionHome(xdg), '/data/helium-sync-companion');
  assert.equal(companionHome({ ...windows, env: { HELIUM_SYNC_COMPANION_HOME: 'D:\\scratch' } }), 'D:\\scratch');
});

test('--user-data-dir from a POSIX or a Windows command line', () => {
  assert.equal(userDataDirFromCommand('/opt/helium/helium --user-data-dir=/tmp/a b/c --no-first-run'), '/tmp/a b/c');
  assert.equal(userDataDirFromCommand('/opt/helium/helium --user-data-dir=/tmp/x'), '/tmp/x');
  assert.equal(userDataDirFromCommand('"C:\\Helium\\chrome.exe" --user-data-dir="C:\\Users\\sam\\My Profile" --flag'), 'C:\\Users\\sam\\My Profile');
  assert.equal(userDataDirFromCommand('"C:\\Helium\\chrome.exe" "--user-data-dir=C:\\Users\\sam\\My Profile" --flag'), 'C:\\Users\\sam\\My Profile');
  assert.equal(userDataDirFromCommand('"C:\\Helium\\chrome.exe" --no-first-run'), null);
});
