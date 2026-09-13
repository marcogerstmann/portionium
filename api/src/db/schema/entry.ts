import { CATEGORIES } from '@portionium/schemas';
import { sql } from 'drizzle-orm';
import { check, index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { baseColumns } from './base.js';
import { foodTable } from './food.js';
import { mealTable } from './meal.js';

/**
 * One thing eaten, in one meal, and what colour it was. The unit this diary counts, see
 * docs/adr/011-an-entry-is-a-colour.md.
 *
 * `food_id` is provenance and `category` is the subject, which is why both are nullable and the
 * CHECK below is what makes the four combinations mean something:
 *
 *   - a food and a colour: a food logged with the colour it had at that moment
 *   - a food and no colour: waiting for a verdict, filled in when its owner gives the food one
 *   - no food and a colour: a bare colour, somebody logging what they ate without naming it
 *   - neither: forbidden by the database rather than by application code, so no migration, CLI
 *     or future adapter can write a row that means nothing
 *
 * The colour is written when the entry is logged and never recomputed on read. Recolouring a
 * food therefore leaves every day it was already eaten on exactly as it was, which is the whole
 * point: a diary records what happened, not what today's opinion would have made of it.
 *
 * `position` is dense and zero based, assigned by createMeal in api/src/domain/meal.ts so no two
 * entries in a meal can share one.
 *
 * `quantity` is nullable and nothing writes it. It is here so a later feature can record a
 * portion without a migration, and it must never become NOT NULL. See the schema for why.
 *
 * The index on `food_id` is what makes the question "how often has this been eaten" cheap. It
 * is asked from two directions: once per delete, to refuse removing a food somebody has eaten,
 * and once per search, to rank a page of candidates by how much use they have seen. Without it
 * both are a scan of every entry ever logged.
 */
export const entryTable = sqliteTable(
  'entry',
  {
    ...baseColumns,
    mealId: text('meal_id')
      .notNull()
      .references(() => mealTable.id, { onDelete: 'cascade' }),
    foodId: text('food_id').references(() => foodTable.id),
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
