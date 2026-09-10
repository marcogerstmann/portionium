import { CATEGORIES, CLASSIFICATION_SOURCES } from '@portionium/schemas';
import { desc } from 'drizzle-orm';
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
  // Resolving a food's colour reads every verdict for that food that the caller may see and
  // picks the newest one that wins. That is the only way this table is ever queried, and the
  // three columns are the three the query names, in the order it names them: the food, then
  // whose verdicts count, then the order the winner is picked in. Without the third the engine
  // matches on the first two and sorts what it finds; with it the rows arrive in the order the
  // resolution rule wants them. See docs/adr/007-append-only-classification-log.md.
  (table) => [
    index('food_classification_food_idx').on(table.foodId, table.userId, desc(table.createdAt)),
  ],
);
