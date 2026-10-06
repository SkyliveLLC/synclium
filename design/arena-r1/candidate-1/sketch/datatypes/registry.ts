// The registry. Adding a data type = one file in datatypes/ + one line here.
// Both the host (engine) and the extension bundle import this, so the two halves cannot drift:
// the extension dispatches bridge calls by `name`, and its manifest permissions are derived below.

import type { AnyDataType, FacetOf, RecordOf } from '../engine/model.ts';
import { bookmarks } from './bookmarks.ts';

export const registry = {
  bookmarks,
  // openTabs,   // publish: each device lists its tabs; others read them. Not v1 (see DESIGN.md).
} as const satisfies { readonly [name: string]: AnyDataType };

export type Registry = typeof registry;
export type TypeName = keyof Registry;
export type RecordOfType<N extends TypeName> = RecordOf<Registry[N]>;
export type FacetOfType<N extends TypeName> = FacetOf<Registry[N]>;

/** Base permissions + every type's. Feeds extension/manifest.ts; a new type's permission lands automatically. */
export const extensionPermissions: readonly chrome.runtime.ManifestPermission[] = [
  'nativeMessaging',
  'storage',
  'alarms',
  ...new Set(Object.values(registry).flatMap((t) => t.permissions)),
];
