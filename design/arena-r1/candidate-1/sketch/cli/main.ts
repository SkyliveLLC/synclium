// The CLI frontend. Four commands. It never touches the engine directly: it installs the browser side,
// writes config, and talks to running hosts over the control protocol. The same binary is the native host
// (Helium launches it with a chrome-extension:// origin as argv[2]).
//
//   helium-sync setup <folder> [--name <label>]   first device AND every later device (same command)
//   helium-sync status                             every profile on this machine + peers + last outcome
//   helium-sync sync                               force a run now (normally never needed)
//   helium-sync uninstall [--forget]               remove host, local state; --forget also deletes our blob

import { connectAll } from '../control/protocol.ts';
import { runHost } from '../host/daemon.ts';
import { type Paths, resolvePaths, saveConfig } from '../host/local.ts';
import { parseFolder } from '../transports/folder.ts';
import { guideExtensionInstall, installHost, uninstallHost } from './install.ts';

export type Command =
  | { readonly kind: 'setup'; readonly folder: string; readonly label: string | null }
  | { readonly kind: 'status' }
  | { readonly kind: 'sync' }
  | { readonly kind: 'uninstall'; readonly forget: boolean }
  | { readonly kind: 'native-host'; readonly origin: string }
  | { readonly kind: 'usage'; readonly error: string | null };

/** node:util parseArgs; the only place argv strings are interpreted. */
export function parseCommand(argv: readonly string[]): Command {
  throw new Error('not implemented');
}

/**
 * setup is idempotent and order-independent:
 *  1. folder = parseFolder(arg); refuse if config already names a different store (no silent rebinding)
 *  2. saveConfig({ store: { kind: 'folder', path: folder }, label: --name ?? hostname })
 *  3. installHost(paths)
 *  4. hosts = connectAll(run): none within 3 s -> guideExtensionInstall(...) and wait (up to 10 min) for one.
 *     Already-running hosts get `reload-config`.
 *  5. for each host: send `sync`, print the outcome. First run of a profile is a join: adopt, then merge.
 * Exit 0 only when at least one profile synced.
 */
async function setup(paths: Paths, folder: string, label: string | null): Promise<number> {
  throw new Error('not implemented');
}

/** No live host: say Helium is closed and print the last outcome from home/replicas; never an error. */
async function status(paths: Paths): Promise<number> {
  throw new Error('not implemented');
}

export async function main(argv: readonly string[]): Promise<number> {
  const cmd = parseCommand(argv);
  const paths = resolvePaths(process.env, process.platform);
  switch (cmd.kind) {
    case 'setup':
      return setup(paths, cmd.folder, cmd.label);
    case 'status':
      return status(paths);
    case 'sync':
      throw new Error('not implemented'); // connectAll -> send sync to each; none -> "Helium isn't running; changes apply at next launch"
    case 'uninstall':
      throw new Error('not implemented'); // each host: uninstall{forget}; then uninstallHost(paths)
    case 'native-host':
      return runHost(argv);
    case 'usage':
      throw new Error('not implemented');
    default:
      return cmd satisfies never;
  }
}

void [connectAll, saveConfig, parseFolder, guideExtensionInstall, installHost, uninstallHost];
