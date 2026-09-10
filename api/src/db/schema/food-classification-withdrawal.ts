import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { baseColumns } from './base.js';
import { foodTable } from './food.js';
import { userTable } from './user.js';

/**
 * One row per time a user withdrew their own opinion about a food, so resolution can fall back
 * to the AI or seed verdict without updating or deleting a single row of the append-only
 * classification log. See docs/adr/007-append-only-classification-log.md.
 *
 * This table is not that log and carries no verdict, so it is not held to its rule: a row here
 * is never corrected, there is simply never anything to correct. `resolveClassification` treats
 * a user's own verdict as withdrawn when a row here for the same food and user is at least as
 * new, which is also why overriding again needs no cleanup here: the new verdict outdates it by
 * arriving later, the same way a newer verdict already outdates an older one.
 */
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
