import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { baseColumns } from './base.js';
import { userTable } from './user.js';

/**
 * A reading on a scale. Integer grams, never a float: a trend line is a lot of arithmetic over
 * a lot of rows, and kilograms as floats drift through it. Kilograms exist on the wire only.
 *
 * No unique constraint on (user_id, local_date). People weigh themselves twice and both
 * readings are real, which is also why the plausibility check in api/src/domain/weight.ts
 * gives a same day reading a full day of allowance.
 */
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
