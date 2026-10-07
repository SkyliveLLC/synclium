// `install` / `uninstall`: register the companion as Helium's native messaging host for one extension. Helium
// looks the manifest up in `<user-data-dir>/NativeMessagingHosts/<name>.json` (P2).
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HOST_NAME } from '../../extension/src/profile-mode.ts';
import { BINARY_NAME } from './paths.ts';

const EXTENSION_ID = /^[a-p]{32}$/;

export const manifestPath = (userDataDir: string) => join(userDataDir, 'NativeMessagingHosts', `${HOST_NAME}.json`);

/**
 * Copy `binary` into the companion home (unless it runs from there) and point Helium's host manifest at the copy.
 * Returns what it did, one line each.
 */
export function install(options: { readonly binary: string; readonly extensionId: string; readonly userDataDir: string; readonly home: string }): string[] {
  const { binary, extensionId, userDataDir, home } = options;
  if (!EXTENSION_ID.test(extensionId)) throw new Error(`not an extension id: ${extensionId}`);
  if (!existsSync(join(userDataDir, 'Local State'))) throw new Error(`not a Helium user data dir (no Local State): ${userDataDir}`);
  const done: string[] = [];
  const installed = join(home, 'bin', BINARY_NAME);
  if (resolve(binary) !== resolve(installed)) {
    mkdirSync(join(home, 'bin'), { recursive: true });
    // Copy beside, then rename: overwriting a signed binary in place would kill a host running from it.
    const temp = `${installed}.${process.pid}.tmp`;
    copyFileSync(binary, temp);
    chmodSync(temp, 0o755);
    renameSync(temp, installed);
    done.push(`copied ${binary} to ${installed}`);
  }
  const manifest = {
    name: HOST_NAME,
    description: 'helium-sync companion: syncs settings, search engines, and addresses while Helium is closed',
    path: installed,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
  mkdirSync(join(userDataDir, 'NativeMessagingHosts'), { recursive: true });
  writeFileSync(manifestPath(userDataDir), `${JSON.stringify(manifest, null, 2)}\n`);
  done.push(`wrote ${manifestPath(userDataDir)} for chrome-extension://${extensionId}/`);
  return done;
}

export function uninstall(userDataDir: string): string[] {
  const path = manifestPath(userDataDir);
  if (!existsSync(path)) return [`no manifest at ${path}`];
  rmSync(path);
  return [`removed ${path}`];
}
