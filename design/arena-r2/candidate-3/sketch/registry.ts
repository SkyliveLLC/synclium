// The single list of synced data types. Adding a type is one file in types/ plus one key here.
// Round 1 had { bookmarks }. History is the second entry, as that design predicted.
import type { DataType, Rec } from './model.ts';
import { bookmarks } from './types/bookmarks.ts';
import { history } from './types/history.ts';

export type Registry = { readonly [type: string]: DataType<Rec> };

/** Key order is cycle order: cheap and valuable first, so a budget cut falls on history. */
export const registry = { bookmarks, history } as const satisfies Registry;

export type HeliumRegistry = typeof registry;
/** The registry key is also a store path segment, so it must match [a-z][a-z0-9-]*. */
export type TypeName<Reg extends Registry> = keyof Reg & string;
export type RecordOf<D> = D extends DataType<infer R extends Rec> ? R : never;
