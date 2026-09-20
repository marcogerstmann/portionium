import { MEAL_TYPES } from '@portionium/schemas';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { baseColumns } from './base.js';
import { userTable } from './user.js';

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
