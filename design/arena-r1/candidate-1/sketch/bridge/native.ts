// Native messaging between the companion extension and the host process Helium spawns for it.
// Framing (Chromium-defined): 4-byte little-endian length + UTF-8 JSON, over the host's stdin/stdout.
// Limits: host -> extension 1 MB per message (calls are tiny); extension -> host up to 64 MiB (a 50k-node
// read() is ~10 MB). Both directions are parsed here; nothing past this module sees a raw frame.
//
// The message types are shared with extension/worker.ts and are PRIVATE to these two files.

import type { BrowserLink } from '../engine/engine.ts';
import type { DeviceId, Json } from '../engine/model.ts';
import type { ControlRequest } from '../control/protocol.ts';
import type { TypeName } from '../datatypes/registry.ts';

export type ToHost =
  | { readonly t: 'hello'; readonly device: string; readonly extensionVersion: string }
  | { readonly t: 'result'; readonly id: number; readonly ok: true; readonly value: Json }
  | { readonly t: 'result'; readonly id: number; readonly ok: false; readonly error: string }
  | { readonly t: 'changed'; readonly type: TypeName }
  /** Reserved for the future extension-UI frontend: the popup speaks the same control protocol as the CLI. */
  | { readonly t: 'control'; readonly id: number; readonly request: ControlRequest };

export type ToExtension =
  | { readonly t: 'call'; readonly id: number; readonly type: TypeName; readonly op: string; readonly args: Json }
  /** chrome.management.uninstallSelf(): Helium shows its own confirmation. Reverse path of setup. */
  | { readonly t: 'uninstall-self' };

export type Hello = { readonly device: DeviceId; readonly extensionVersion: string };

export interface Bridge {
  /** Resolves with the first frame; rejects if the first frame is not a valid hello. */
  readonly hello: Promise<Hello>;
  readonly browser: BrowserLink;
  onChanged(listener: (type: TypeName) => void): void;
  uninstallExtension(): void;
  /** Resolves when Helium closes stdin (browser quit, extension reloaded or removed). */
  readonly closed: Promise<void>;
}

/** Wrap the host's stdio. Pending calls reject with 'browser-gone' when stdin closes. */
export function openBridge(stdin: NodeJS.ReadableStream, stdout: NodeJS.WritableStream): Bridge {
  throw new Error('not implemented');
}
