import { integer, text } from 'drizzle-orm/sqlite-core';
import { uuidv7 } from 'uuidv7';

/**
 * The columns every table carries. Spread into a table definition so the four housekeeping
 * columns are declared identically everywhere, and a change to them is a change in one place.
 *
 *   sqliteTable('meal', { ...baseColumns, userId: ... })
 *
 * Timestamps are epoch milliseconds, not text. An integer cannot carry an offset, so a local
 * time can never be written by accident, and Drizzle hands back a Date either way.
 */
export const baseColumns = {
  /** UUIDv7. Roughly monotonic, so inserts stay at the right edge of the primary key index. */
  id: text('id')
    .primaryKey()
    .$defaultFn(() => uuidv7()),

  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),

  /**
   * Maintained by Drizzle on updates issued through Drizzle. A raw SQL update bypasses it,
   * which is one more reason writes go through a repository rather than ad hoc statements.
   */
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date()),

  /** Soft delete marker. Null means live. Reads filter on it, they do not rely on the caller. */
  deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
};
