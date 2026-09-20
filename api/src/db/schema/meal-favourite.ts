import { MEAL_TYPES, type EntryInput } from '@portionium/schemas';
import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { baseColumns } from './base.js';
import { userTable } from './user.js';

export const mealFavouriteTable = sqliteTable(
  'meal_favourite',
  {
    ...baseColumns,
    userId: text('user_id')
      .notNull()
      .references(() => userTable.id),
    name: text('name').notNull(),
    type: text('type', { enum: MEAL_TYPES }).notNull(),
    entries: text('entries', { mode: 'json' }).notNull().$type<EntryInput[]>(),
  },
  (table) => [index('meal_favourite_user_type_idx').on(table.userId, table.type)],
);
