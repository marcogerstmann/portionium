import { FOOD_KINDS } from '@portionium/schemas';
import { real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { baseColumns } from './base.js';
import { userTable } from './user.js';

/**
 * A thing that can be eaten. Deliberately carries no category: what colour a food is depends on
 * who is asking and who decided, which is a row in food_classification, not a column here.
 *
 * `energy_density` is kilocalories per 100 g and is usually null. Nothing reads it yet.
 *
 * `created_by` is null on the entries that ship with the app, the same way `user_id` is null
 * on a shared classification. A catalog entry everybody sees was authored by nobody, and the
 * alternative, a synthetic account to point the column at, is an account that every later
 * login, listing and permission check would have to remember to exclude.
 */
export const foodTable = sqliteTable('food', {
  ...baseColumns,
  name: text('name').notNull(),
  kind: text('kind', { enum: FOOD_KINDS }).notNull(),
  energyDensity: real('energy_density'),
  createdBy: text('created_by').references(() => userTable.id),
});
