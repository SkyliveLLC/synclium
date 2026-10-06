// The v1 scope. One import + one array entry per data type; nothing else changes when a type is added.
// Lives apart from datatype.ts so the concrete types can import `defineDataType` without a cycle.

import type { DataType, Fields } from './datatype.ts';
import { bookmarks } from './types/bookmarks.ts';
import { history } from './types/history.ts';

/**
 * `DataType` declares its methods with method syntax, so `DataType<BookmarkFields>` is assignable to
 * `DataType<Fields>` (method bivariance) and the engine stays generic per entry.
 */
export const registry = [bookmarks, history] as const satisfies readonly DataType<Fields>[];
