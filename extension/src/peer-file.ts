// Fetch one peer file named by its manifest and open it. Shared by the register and snapshot cycles; the log
// cycle keeps its own loop because it fetches under a budget and records peer days.
import type { DeviceId } from './model.ts';
import type { CycleContext, Warning } from './engine.ts';
import { keys, open, type FileEntry, type RelName } from './store-format.ts';

/** The opened body, or null when the file is not usable now. Every null pushes the warning that says why. */
export async function fetchPeerBody(ctx: CycleContext, peer: DeviceId, rel: RelName, entry: FileEntry, warnings: Warning[]): Promise<{ readonly body: unknown } | null> {
  const key = keys.file(peer, rel);
  const fetched = await ctx.store.use((store) => store.get(key, null));
  if (fetched === null) return null;
  if (fetched.kind !== 'ok') {
    warnings.push({ kind: 'not-yet', peer, file: rel });
    return null;
  }
  const opened = await open(fetched.bytes, ctx.cipher, key, entry);
  switch (opened.kind) {
    case 'ok':
      return { body: opened.body };
    // A file under another key behind a manifest under ours was not written by that peer: as good as torn.
    case 'not-yet':
    case 'other-key':
      warnings.push({ kind: 'not-yet', peer, file: rel });
      return null;
    case 'newer-format':
      warnings.push({ kind: 'newer-version', peer, file: rel, version: opened.formatVersion });
      return null;
    case 'unknown-codec':
      warnings.push({ kind: 'unknown-codec', peer, codec: opened.codec });
      return null;
    default: {
      const unreachable: never = opened;
      return unreachable;
    }
  }
}
