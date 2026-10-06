// The single list of synced data types. Adding a type is one file in types/ plus one key here.
// Every derived type below follows the registry, so adapters and reports adapt without edits.
import type { DataType, Rec } from './model.ts';
import { bookmarks } from './types/bookmarks.ts';

export type Registry = { readonly [type: string]: DataType<Rec> };

export const registry = { bookmarks } as const satisfies Registry;
// Next entries (not v1): `history` (merge type via the file adapter), then `openTabs` and `extensions`
// as publish-only types via the live adapter. See DESIGN.md "v1 scope".

export type HeliumRegistry = typeof registry;
/** The registry key doubles as the store file name, so it must match [a-z][a-z0-9-]*. */
export type TypeName<Reg extends Registry> = keyof Reg & string;
export type RecordOf<D> = D extends DataType<infer R extends Rec> ? R : never;
