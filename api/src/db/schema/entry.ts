import { CATEGORIES } from '@portionium/schemas';
import { sql } from 'drizzle-orm';
import { check, index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { baseColumns } from './base.js';
import { foodTable } from './food.js';
import { mealTable } from './meal.js';

export const entryTable = sqliteTable(
  'entry',
  {
    ...baseColumns,
    mealId: text('meal_id')
      .notNull()
      .references(() => mealTable.id, { onDelete: 'cascade' }),
    foodId: text('food_id').references(() => foodTable.id, { onDelete: 'set null' }),
    category: text('category', { enum: CATEGORIES }),
    quantity: real('quantity'),
    position: integer('position').notNull(),
  },
  (table) => [
    index('entry_food_idx').on(table.foodId),
    check(
      'entry_food_or_category',
      sql`${table.foodId} is not null or ${table.category} is not null`,
    ),
  ],
);
