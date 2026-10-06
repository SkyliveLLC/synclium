// What crosses between extension pages (popup, setup) and the service worker. Three channels, each with
// ONE writer, so nothing in the extension is a shared mutable object (per separate-before-serializing-shared-state):
//
//   settings   chrome.storage.local['settings']   written by pages only; the worker reads it at the start of every cycle
//   status     chrome.storage.local['status']     written by the worker only; pages render it live via storage.onChanged
//   engine     IndexedDB (local-idb.ts, corpus)   written by the worker only, inside the cycle lock; pages may read the corpus
//
// Pages never run the engine. They ask the worker with the typed RPC below, which also wakes it if it was asleep.
import type { HeliumRegistry, TypeName } from '../registry.ts';
import type { SyncReport } from '../engine.ts';
import type { FileModeStatus } from '../file-mode/host-link.ts';

export type Settings = {
  /** null until setup finishes. The worker does nothing while it is null. */
  readonly store: StoreChoice | null;
  readonly deviceName: string;
  /** Keyed by the registry, so a new type is a compile error here until the UI decides its default. */
  readonly types: { readonly [K in TypeName<HeliumRegistry>]: boolean };
  /** Opt-in. Needs the optional `nativeMessaging` permission and the host installed. See file-mode/. */
  readonly fileMode: boolean;
};
export type StoreChoice =
  | { readonly kind: 'folder' } // the FileSystemDirectoryHandle lives in IndexedDB (adapters/fsa-store.ts), not here
  | { readonly kind: 'webdav'; readonly url: string; readonly user: string; readonly password: string };

export type CycleState =
  | { readonly state: 'idle' }
  | { readonly state: 'running'; readonly since: number }
  | { readonly state: 'waiting'; readonly until: number; readonly why: 'debounce' | 'budget' | 'retry' };

export type Status = {
  readonly cycle: CycleState;
  readonly last: SyncReport | null;
  /** Unexpected failures only (a bug, a corrupt file). A lapsed folder grant is `last.store`, not an error. */
  readonly lastError: { readonly at: number; readonly message: string; readonly failures: number } | null;
  /** null when file mode is off. */
  readonly fileMode: FileModeStatus | null;
};

// ---------- RPC ----------

export type Rpc = {
  /** Run a cycle now. Resolves with the status after it. */
  'sync-now': { readonly req: Record<string, never>; readonly res: Status };
  /** engine.sync({ dryRun: true }), for the setup page's "here is what joining will do". Takes the cycle lock. */
  preview: { readonly req: Record<string, never>; readonly res: SyncReport };
  /** The user confirmed a blocked mass delete, so the next cycle runs with `force: [type]`. */
  'confirm-mass-delete': { readonly req: { readonly type: TypeName<HeliumRegistry> }; readonly res: Status };
  /** history.html's "remove from synced history". The corpus has one writer, so the page asks. Observed then lacks the visits and the fold tombstones them. */
  'forget-visits': { readonly req: { readonly ids: readonly string[] }; readonly res: Status };
  /** engine.forget(): delete this device's files from the store. */
  'remove-device': { readonly req: Record<string, never>; readonly res: Status };
};

export type RpcEnvelope = { readonly [K in keyof Rpc]: { readonly t: K } & Rpc[K]['req'] }[keyof Rpc];

/** Page side. `chrome.runtime.sendMessage` wakes the worker. */
export function call<K extends keyof Rpc>(_t: K, _req: Rpc[K]['req']): Promise<Rpc[K]['res']> {
  throw new Error('not implemented');
}

/** Worker side. One handler per RPC, enforced by the mapped type. The listener returns true to keep the channel open. */
export type RpcHandlers = { readonly [K in keyof Rpc]: (req: Rpc[K]['req']) => Promise<Rpc[K]['res']> };
export function serve(_handlers: RpcHandlers): void {
  throw new Error('not implemented');
}
