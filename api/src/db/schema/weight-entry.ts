import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { baseColumns } from './base.js';
import { userTable } from './user.js';

export const weightEntryTable = sqliteTable(
  'weight_entry',
  {
    ...baseColumns,
    userId: text('user_id')
      .notNull()
      .references(() => userTable.id),
    weightGrams: integer('weight_grams').notNull(),
    localDate: text('local_date').notNull(),
    recordedAt: integer('recorded_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [index('weight_entry_user_local_date_idx').on(table.userId, table.localDate)],
);
