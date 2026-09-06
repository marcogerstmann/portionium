import { FOOD_KINDS } from '@portionium/schemas';
import { real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { baseColumns } from './base.js';
import { userTable } from './user.js';

/**
 * A thing that can be eaten. Deliberately carries no category: what colour a food is depends on
 * who is asking and who decided, which is a row in food_classification, not a column here.
 *
 * `energy_density` is kilocalories per 100 g and is usually null. Nothing reads it yet.
 */
export const foodTable = sqliteTable('food', {
  ...baseColumns,
  name: text('name').notNull(),
  kind: text('kind', { enum: FOOD_KINDS }).notNull(),
  energyDensity: real('energy_density'),
  createdBy: text('created_by')
    .notNull()
    .references(() => userTable.id),
});
