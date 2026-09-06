import { MEAL_TYPES } from '@portionium/schemas';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { baseColumns } from './base.js';
import { userTable } from './user.js';

/**
 * Something eaten at a point in time. `logged_at` is the truth, in UTC. `local_date` is that
 * instant rendered in the user's timezone and written alongside it.
 *
 * Denormalised rather than computed on read because every list, streak and summary groups by
 * the user's day, and SQLite cannot apply a timezone in a query. Grouping has to happen on an
 * indexable column, which is what the index below is for.
 */
export const mealTable = sqliteTable(
  'meal',
  {
    ...baseColumns,
    userId: text('user_id')
      .notNull()
      .references(() => userTable.id),
    type: text('type', { enum: MEAL_TYPES }).notNull(),
    loggedAt: integer('logged_at', { mode: 'timestamp_ms' }).notNull(),
    localDate: text('local_date').notNull(),
    notes: text('notes'),
  },
  (table) => [index('meal_user_local_date_idx').on(table.userId, table.localDate)],
);
