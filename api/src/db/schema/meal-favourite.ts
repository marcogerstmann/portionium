import { MEAL_TYPES, type MealItemInput } from '@portionium/schemas';
import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { baseColumns } from './base.js';
import { userTable } from './user.js';

/**
 * A meal composition a user has named and pinned on purpose, "Standard Frühstück", rather than
 * one this API noticed from history, see meal-suggestions.ts. Favourites are private, always
 * owned, there is no shared favourite the way there is a shared food.
 *
 * `items` is JSON rather than a child table, the tradeoff api_token's `scopes` already makes: a
 * handful of rows per user, read whole and never queried by the food inside them. The array's
 * own order is the order, so a favourite's items go straight into createMeal to become a real
 * meal's, the same as a client's own item list would.
 */
export const mealFavouriteTable = sqliteTable(
  'meal_favourite',
  {
    ...baseColumns,
    userId: text('user_id')
      .notNull()
      .references(() => userTable.id),
    name: text('name').notNull(),
    type: text('type', { enum: MEAL_TYPES }).notNull(),
    items: text('items', { mode: 'json' }).notNull().$type<MealItemInput[]>(),
  },
  // Both reads are by owner, optionally narrowed to one meal type: listing a user's favourites,
  // and the suggestions endpoint's own reasoning applied to a shortlist rather than a ranking.
  (table) => [index('meal_favourite_user_type_idx').on(table.userId, table.type)],
);
