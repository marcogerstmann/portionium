import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { baseColumns } from './base.js';
import { foodTable } from './food.js';
import { mealTable } from './meal.js';

/**
 * One food in one meal. `position` is dense and zero based, assigned by createMeal in
 * api/src/domain/meal.ts so no two items in a meal can share one.
 *
 * `quantity` is nullable and nothing writes it. It is here so a later feature can record a
 * portion without a migration, and it must never become NOT NULL. See the schema for why.
 *
 * The index on `food_id` is what makes the question "how often has this been eaten" cheap. It
 * is asked from two directions: once per delete, to refuse removing a food somebody has eaten,
 * and once per search, to rank a page of candidates by how much use they have seen. Without it
 * both are a scan of every item ever logged.
 */
export const mealItemTable = sqliteTable(
  'meal_item',
  {
    ...baseColumns,
    mealId: text('meal_id')
      .notNull()
      .references(() => mealTable.id, { onDelete: 'cascade' }),
    foodId: text('food_id')
      .notNull()
      .references(() => foodTable.id),
    quantity: real('quantity'),
    position: integer('position').notNull(),
  },
  (table) => [index('meal_item_food_idx').on(table.foodId)],
);
