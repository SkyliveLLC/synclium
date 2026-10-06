// Thin frontend. Parses argv, builds adapters, calls the engine, prints the report.
//
//   helium-sync init <folder> [--name <n>] [--profile <dir>]   every device, same command; creates or joins
//   helium-sync status                                          dry-run cycle + peers + Helium run state
//   helium-sync sync [--dry-run] [--force]                      one cycle now
//   helium-sync restore [--list | <backup>]                     defaults to the newest backup; refuses while Helium runs
//   helium-sync uninstall [--forget]                            agent + local state; --forget also deletes our store files
//   helium-sync daemon                                          what the agent runs; not for users
import type { BackupId } from './adapters/file-profile.ts';

export type Command =
  | { readonly kind: 'init'; readonly folder: string; readonly name: string | null; readonly profile: string | null }
  | { readonly kind: 'status' }
  | { readonly kind: 'sync'; readonly dryRun: boolean; readonly force: boolean }
  | { readonly kind: 'restore'; readonly target: { readonly kind: 'list' } | { readonly kind: 'newest' } | { readonly kind: 'backup'; readonly id: BackupId } }
  | { readonly kind: 'uninstall'; readonly forget: boolean }
  | { readonly kind: 'daemon' }
  | { readonly kind: 'usage'; readonly error: string | null };

/** node:util parseArgs. The only place argv strings are interpreted. */
export function parseCommand(_argv: readonly string[]): Command {
  throw new Error('not implemented');
}

export async function main(argv: readonly string[]): Promise<number> {
  const cmd = parseCommand(argv);
  switch (cmd.kind) {
    case 'init':
      // Idempotent. Rerunning repairs a half-finished install or a moved node binary.
      // 1. folder = parseFolder(cmd.folder). Refuse if config already names a different folder.
      // 2. saveConfig. local.load() mints the DeviceId on first run.
      // 3. engine.sync(). When peers exist, the first cycle is a join. It adopts by content, then merges.
      // 4. installService. Print the report.
      throw new Error('not implemented');
    case 'status':
    case 'sync':
    case 'restore':
    case 'uninstall':
    case 'daemon':
    case 'usage':
      throw new Error('not implemented');
    default: {
      const unreachable: never = cmd;
      return unreachable;
    }
  }
}
