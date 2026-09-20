import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { baseColumns } from './base.js';
import { foodTable } from './food.js';
import { userTable } from './user.js';

export const foodClassificationWithdrawalTable = sqliteTable(
  'food_classification_withdrawal',
  {
    ...baseColumns,
    foodId: text('food_id')
      .notNull()
      .references(() => foodTable.id),
    userId: text('user_id')
      .notNull()
      .references(() => userTable.id),
  },
  (table) => [index('food_classification_withdrawal_food_idx').on(table.foodId, table.userId)],
);
