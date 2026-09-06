import { CATEGORIES, CLASSIFICATION_SOURCES } from '@portionium/schemas';
import { index, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { baseColumns } from './base.js';
import { foodTable } from './food.js';
import { userTable } from './user.js';

/**
 * One verdict about one food. Append only in spirit: a user overriding an AI verdict adds a
 * row rather than editing one, so the disagreement survives and the prompt that produced the
 * original can be evaluated against it later.
 *
 * `user_id` is null on the rows that apply to everyone, the seeds and the shared AI verdicts.
 * The provenance columns are null on anything a model did not produce.
 */
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
    /** JSON array of strings. A list this small does not earn a table of its own. */
    assumptions: text('assumptions', { mode: 'json' }).$type<string[]>(),
  },
  // Resolving a food's colour reads every verdict for that food and picks one. That is the
  // only way this table is ever queried.
  (table) => [index('food_classification_food_idx').on(table.foodId, table.userId)],
);
