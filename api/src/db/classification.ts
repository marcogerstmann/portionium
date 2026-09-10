import type { Category, ClassificationSource } from '@portionium/schemas';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';

import type { Db } from './client.js';
import { foodClassificationTable } from './schema/index.js';

/**
 * Every query the classification log needs, and deliberately no more than that.
 *
 * This module exposes one write, and it inserts. There is no update and no delete here, and
 * that absence is the enforcement: a verdict is never corrected, it is superseded by a newer
 * row, so the chain of who said what about a food and when survives whatever anybody does
 * next. Why that is worth a table where a column would have done, what it costs on every read,
 * and what it buys later: docs/adr/007-append-only-classification-log.md.
 *
 * The reads take a `userId`, and unlike the catalog's they use it. A classification either
 * belongs to everybody, the seeds and the shared model verdicts, or to exactly one account,
 * and nothing here returns a row of the second kind to anybody else. What is then done with
 * the rows, which one wins and in what order, is domain/classification.ts and nowhere else.
 */

export type FoodClassificationRecord = typeof foodClassificationTable.$inferSelect;

export interface NewClassification {
  foodId: string;
  category: Category;
  source: ClassificationSource;
  /** Null on the rows that apply to everyone: the seeds and the shared model verdicts. */
  userId?: string | null;
  model?: string | null;
  promptVersion?: string | null;
  confidence?: number | null;
  reasoning?: string | null;
  assumptions?: string[] | null;
}

/**
 * The rows a user may see about these foods: the shared ones and their own.
 *
 * Correlated on the caller in SQL rather than filtered afterwards, so a household member's
 * opinion never leaves the database, and one query rather than one per food, so a page of
 * fifty entries stays two queries. Resolution happens over the result.
 */
function visibleTo(userId: string) {
  return or(isNull(foodClassificationTable.userId), eq(foodClassificationTable.userId, userId));
}

/**
 * The only way a verdict is written.
 *
 * Takes a list because the seed loader inserts a few hundred at once and a caller with one
 * verdict passes one. Returning the rows rather than a count means the endpoint that writes an
 * override can answer with what it stored, without reading it back.
 */
export function insertClassifications(
  db: Db,
  verdicts: readonly NewClassification[],
): FoodClassificationRecord[] {
  if (verdicts.length === 0) {
    return [];
  }

  return db
    .insert(foodClassificationTable)
    .values([...verdicts])
    .returning()
    .all();
}

/**
 * Every verdict on these foods that this user may see, in one query rather than one per food.
 */
export function findClassificationsForFoods(
  db: Db,
  foodIds: readonly string[],
  userId: string,
): FoodClassificationRecord[] {
  if (foodIds.length === 0) {
    return [];
  }

  return db
    .select()
    .from(foodClassificationTable)
    .where(and(inArray(foodClassificationTable.foodId, [...foodIds]), visibleTo(userId)))
    .all();
}

/**
 * The whole chain for one food, newest first: what shipped with the catalog, what a model said,
 * and what this user said back, with everything that has been superseded still in place.
 *
 * The id breaks a tie on the instant, the same way the resolution rule does. A seed run writes
 * a few hundred rows in one millisecond, and a history whose order depends on what SQLite
 * happened to return is a history that reads differently on two machines. Ids are UUIDv7, so
 * comparing them compares creation order.
 */
export function findClassificationHistory(
  db: Db,
  foodId: string,
  userId: string,
): FoodClassificationRecord[] {
  return db
    .select()
    .from(foodClassificationTable)
    .where(and(eq(foodClassificationTable.foodId, foodId), visibleTo(userId)))
    .orderBy(desc(foodClassificationTable.createdAt), desc(foodClassificationTable.id))
    .all();
}
