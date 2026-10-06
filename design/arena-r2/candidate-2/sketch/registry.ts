// The single list of synced data types. Adding a type is one file in types/ plus one key here.
// Everything below is derived from the registry, so adapters, local state, and the UI adapt without edits.
import type { DataType, Ev, LogType, Rec, RegisterType } from './model.ts';
import { bookmarks } from './types/bookmarks.ts';
import { history } from './types/history.ts';

export type Registry = { readonly [type: string]: DataType };

export const registry = { bookmarks, history } as const satisfies Registry;

export type HeliumRegistry = typeof registry;
/** The registry key doubles as the store file name, so it must match [a-z][a-z0-9-]*. */
export type TypeName<Reg extends Registry> = keyof Reg & string;

/** Keys of the register types and of the log types. `Profile` and `LocalState` are keyed by these. */
export type RegisterTypes<Reg extends Registry> = { [K in TypeName<Reg>]: Reg[K] extends RegisterType<Rec> ? K : never }[TypeName<Reg>];
export type LogTypes<Reg extends Registry> = { [K in TypeName<Reg>]: Reg[K] extends LogType<Ev> ? K : never }[TypeName<Reg>];

export type RecordOf<D> = D extends RegisterType<infer R extends Rec> ? R : never;
export type EventOf<D> = D extends LogType<infer E extends Ev> ? E : never;
