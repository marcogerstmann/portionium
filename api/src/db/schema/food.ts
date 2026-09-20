import { FOOD_KINDS } from '@portionium/schemas';
import { real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { baseColumns } from './base.js';
import { userTable } from './user.js';

export const foodTable = sqliteTable('food', {
  ...baseColumns,
  name: text('name').notNull(),
  kind: text('kind', { enum: FOOD_KINDS }).notNull(),
  energyDensity: real('energy_density'),
  createdBy: text('created_by').references(() => userTable.id),
});
