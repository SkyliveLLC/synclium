// The extension's whole view of file mode. Everything about the host is behind `HostLink`; the rest of the
// extension sees one decorator and one status type. Turning file mode off or never installing the host
// leaves the corpus-only behaviour untouched, and there is no `if (fileMode)` anywhere in the engine.
//
// Opt-in is two steps, both explicit in setup.html: grant the optional `nativeMessaging` permission (a browser
// prompt), and install the host (a download the user runs). The setup page states plainly that the host writes to
// Helium's History database while Helium is closed, with backups, and that Helium's own README says its
// storage should only be changed through its APIs.
import type { WriteChannel } from '../ports.ts';
import type { Corpus } from '../adapters/corpus.ts';
import type { Visit } from '../types/history.ts';
import type { Receipt } from './protocol.ts';

export type FileModeStatus = {
  readonly link: 'no-permission' | 'no-host' | 'connected';
  /** Corpus visits the host has not yet reported importing. They are searchable in the extension meanwhile. */
  readonly staged: number;
  readonly lastImport: Receipt | null;
};

export interface HostLink {
  /** connectNative, hello, collect receipts. Resolves to `no-host` instead of throwing when the host is not installed. */
  status(): Promise<FileModeStatus>;
  /** Idempotent. The host dedupes by (url, time). */
  stage(visits: readonly Visit[]): Promise<void>;
}

export function connectHost(): HostLink {
  throw new Error('not implemented');
}

/**
 * The file-mode upgrade as a decorator on the history channel. read is untouched. apply runs the base
 * (corpus, immediate, searchable now), then stages the added visits for the host to import at the next quit.
 * On connect the worker also stages every corpus visit once (`stageBacklog`), which covers a host installed after
 * history was already syncing. If the host is down, stage is dropped, because the corpus still holds the visits
 * and the backlog resend repairs it. File mode never defers or fails a cycle.
 */
export function withNativeHistory(base: WriteChannel<Visit>, link: HostLink): WriteChannel<Visit> {
  return {
    read: (previous) => base.read(previous),
    bind: (aliases) => base.bind(aliases),
    async apply(change) {
      const result = await base.apply(change);
      if (result.kind === 'applied') {
        const added = [...change.target].filter(([id]) => !change.current.has(id)).map(([, visit]) => visit);
        if (added.length > 0) await link.stage(added).catch(() => undefined);
      }
      return result;
    },
  };
}

export async function stageBacklog(corpus: Corpus, link: HostLink): Promise<void> {
  await link.stage([...(await corpus.all()).values()]);
}
