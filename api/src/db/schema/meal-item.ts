import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { baseColumns } from './base.js';
import { foodTable } from './food.js';
import { mealTable } from './meal.js';

/**
 * One food in one meal. `position` is dense and zero based, assigned by createMeal in
 * api/src/domain/meal.ts so no two items in a meal can share one.
 *
 * `quantity` is nullable and nothing writes it. It is here so a later feature can record a
 * portion without a migration, and it must never become NOT NULL. See the schema for why.
 */
export const mealItemTable = sqliteTable('meal_item', {
  ...baseColumns,
  mealId: text('meal_id')
    .notNull()
    .references(() => mealTable.id, { onDelete: 'cascade' }),
  foodId: text('food_id')
    .notNull()
    .references(() => foodTable.id),
  quantity: real('quantity'),
  position: integer('position').notNull(),
});
