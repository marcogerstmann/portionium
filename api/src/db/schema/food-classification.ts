import { CATEGORIES, CLASSIFICATION_SOURCES } from '@portionium/schemas';
import { desc } from 'drizzle-orm';
import { index, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { baseColumns } from './base.js';
import { foodTable } from './food.js';
import { userTable } from './user.js';

export const foodClassificationTable = sqliteTable(
  'food_classification',
  {
    ...baseColumns,
    foodId: text('food_id')
      .notNull()
      .references(() => foodTable.id),
    userId: text('user_id').references(() => userTable.id),
    category: text('category', { enum: CATEGORIES }).notNull(),
    source: text('source', { enum: CLASSIFICATION_SOURCES }).notNull(),
    model: text('model'),
    promptVersion: text('prompt_version'),
    confidence: real('confidence'),
    reasoning: text('reasoning'),
    assumptions: text('assumptions', { mode: 'json' }).$type<string[]>(),
  },
  (table) => [
    index('food_classification_food_idx').on(table.foodId, table.userId, desc(table.createdAt)),
  ],
);
