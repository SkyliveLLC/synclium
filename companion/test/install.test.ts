import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { install, manifestPath, REGISTRY_KEY, uninstall } from '../src/install.ts';
import { binaryFile, currentOs } from '../src/paths.ts';
import { makeFixture } from './fixture.ts';

const EXTENSION_ID = 'nbdgcdhlckcnhkjnjafmaiegeidcmmap';

/** A stand-in for the downloaded binary, beside the fixture's user data dir. */
function fakeBinary(userDataDir: string, contents: string): string {
  const path = join(dirname(userDataDir), 'downloaded-companion');
  writeFileSync(path, contents);
  return path;
}

test('install copies the binary into the companion home and points the manifest at it; reinstall replaces it', () => {
  const { home, userDataDir } = makeFixture();
  const options = { extensionId: EXTENSION_ID, userDataDir, home };
  install({ ...options, binary: fakeBinary(userDataDir, 'v1') });
  install({ ...options, binary: fakeBinary(userDataDir, 'v2') });

  const installed = join(home, 'bin', binaryFile());
  assert.equal(readFileSync(installed, 'utf8'), 'v2');
  const manifest: unknown = JSON.parse(readFileSync(manifestPath(userDataDir, home), 'utf8'));
  assert.deepEqual(manifest, {
    name: 'computer.skylive.helium_sync',
    description: 'Synclium companion: syncs settings, search engines, and addresses while Helium is closed',
    path: installed,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  });
  if (currentOs() !== 'win32') assert.equal(manifestPath(userDataDir, home), join(userDataDir, 'NativeMessagingHosts', 'computer.skylive.helium_sync.json'));

  uninstall(userDataDir, home);
  assert.equal(existsSync(manifestPath(userDataDir, home)), false);
});

test('install refuses a bad extension id and a dir that is not Helium', () => {
  const { home, userDataDir } = makeFixture();
  const binary = fakeBinary(userDataDir, 'v1');
  assert.throws(() => install({ binary, extensionId: 'not-an-id', userDataDir, home }), /not an extension id/);
  assert.throws(() => install({ binary, extensionId: EXTENSION_ID, userDataDir: dirname(userDataDir), home }), /not a Helium user data dir/);
});

// Writes the real HKCU key, so only on a CI runner.
test('on Windows the registry key names the manifest, and uninstall removes it', { skip: (currentOs() !== 'win32' || process.env['CI'] === undefined) && 'Windows CI only' }, () => {
  const { home, userDataDir } = makeFixture();
  install({ binary: fakeBinary(userDataDir, 'v1'), extensionId: EXTENSION_ID, userDataDir, home });
  assert.match(execFileSync('reg', ['query', REGISTRY_KEY, '/ve'], { encoding: 'utf8' }), new RegExp(manifestPath(userDataDir, home).replaceAll('\\', '\\\\')));
  uninstall(userDataDir, home);
  assert.throws(() => execFileSync('reg', ['query', REGISTRY_KEY, '/ve'], { stdio: 'ignore' }));
});
