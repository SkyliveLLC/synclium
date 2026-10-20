// `install` / `uninstall`: register the companion as Helium's native messaging host for one extension. On macOS and
// Linux, Helium looks the manifest up in `<user-data-dir>/NativeMessagingHosts/<name>.json` (P2). On Windows it
// reads the manifest's path from the registry key Chromium-branded browsers share, so the manifest lives in the
// companion home.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HOST_NAME } from '../../extension/src/profile-mode.ts';
import { binaryFile, currentOs, type Os } from './paths.ts';

const EXTENSION_ID = /^[a-p]{32}$/;
export const REGISTRY_KEY = `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${HOST_NAME}`;

export const manifestPath = (userDataDir: string, home: string, os: Os = currentOs()) =>
  os === 'win32' ? join(home, `${HOST_NAME}.json`) : join(userDataDir, 'NativeMessagingHosts', `${HOST_NAME}.json`);

/** Put `binary` at `installed`. Copy beside, then rename: overwriting in place would kill a host running from it. */
function placeBinary(binary: string, installed: string): void {
  const temp = `${installed}.${process.pid}.tmp`;
  copyFileSync(binary, temp);
  chmodSync(temp, 0o755);
  try {
    renameSync(temp, installed);
  } catch (error) {
    // Windows refuses to replace a running .exe but lets it be renamed away.
    if (!(error instanceof Error && 'code' in error && error.code === 'EPERM')) throw error;
    const old = `${installed}.${process.pid}.old`;
    renameSync(installed, old);
    renameSync(temp, installed);
    rmSync(old, { force: true });
  }
}

/**
 * Copy `binary` into the companion home (unless it runs from there) and point Helium's host manifest at the copy.
 * Returns what it did, one line each.
 */
export function install(options: { readonly binary: string; readonly extensionId: string; readonly userDataDir: string; readonly home: string; readonly os?: Os }): string[] {
  const { binary, extensionId, userDataDir, home, os = currentOs() } = options;
  if (!EXTENSION_ID.test(extensionId)) throw new Error(`not an extension id: ${extensionId}`);
  if (!existsSync(join(userDataDir, 'Local State'))) throw new Error(`not a Helium user data dir (no Local State): ${userDataDir}`);
  const done: string[] = [];
  const installed = join(home, 'bin', binaryFile(os));
  if (resolve(binary) !== resolve(installed)) {
    mkdirSync(join(home, 'bin'), { recursive: true });
    placeBinary(binary, installed);
    done.push(`copied ${binary} to ${installed}`);
  }
  const manifest = {
    name: HOST_NAME,
    description: 'Synclium companion: syncs settings, search engines, and addresses while Helium is closed',
    path: installed,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
  const path = manifestPath(userDataDir, home, os);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  done.push(`wrote ${path} for chrome-extension://${extensionId}/`);
  if (os === 'win32') {
    execFileSync('reg', ['add', REGISTRY_KEY, '/ve', '/t', 'REG_SZ', '/d', path, '/f'], { stdio: 'ignore', windowsHide: true });
    done.push(`registered it at ${REGISTRY_KEY}`);
  }
  return done;
}

export function uninstall(userDataDir: string, home: string, os: Os = currentOs()): string[] {
  const done: string[] = [];
  if (os === 'win32') {
    try {
      execFileSync('reg', ['delete', REGISTRY_KEY, '/f'], { stdio: 'ignore', windowsHide: true });
      done.push(`removed ${REGISTRY_KEY}`);
    } catch {
      done.push(`no registry key ${REGISTRY_KEY}`);
    }
  }
  const path = manifestPath(userDataDir, home, os);
  if (!existsSync(path)) return [...done, `no manifest at ${path}`];
  rmSync(path);
  return [...done, `removed ${path}`];
}
