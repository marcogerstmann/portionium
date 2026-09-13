import type { Category, ClassificationSource } from '@portionium/schemas';
import { and, desc, eq, exists, gte, inArray, isNull, not, notExists, or, sql } from 'drizzle-orm';

import type { Db } from './client.js';
import {
  entryTable,
  foodClassificationTable,
  foodClassificationWithdrawalTable,
  mealTable,
} from './schema/index.js';

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
 *
 * Exported for db/unclassified.ts, which filters the classification log by this same rule
 * before it has a food id to correlate on.
 */
export function visibleTo(userId: string) {
  return or(isNull(foodClassificationTable.userId), eq(foodClassificationTable.userId, userId));
}

/**
 * Whether the caller withdrew their own verdict on the correlated row's food at or after that
 * verdict was written. Correlated on the outer query, the same way visibleClassifications in
 * food.ts is, so asking "is this withdrawn" costs an index lookup rather than a second round
 * trip. See food-classification-withdrawal.ts for why a newer withdrawal is what outdates it,
 * and why a still newer verdict needs nothing done to it to stop being withdrawn.
 */
function withdrawnSince(db: Db, userId: string) {
  return db
    .select({ present: sql`1` })
    .from(foodClassificationWithdrawalTable)
    .where(
      and(
        eq(foodClassificationWithdrawalTable.foodId, foodClassificationTable.foodId),
        eq(foodClassificationWithdrawalTable.userId, userId),
        gte(foodClassificationWithdrawalTable.createdAt, foodClassificationTable.createdAt),
      ),
    );
}

/**
 * The only way a verdict is written.
 *
 * Takes a list because the seed loader inserts a few hundred at once and a caller with one
 * verdict passes one. Returning the rows rather than a count means the endpoint that writes an
 * override can answer with what it stored, without reading it back.
 *
 * A `user` verdict does a second thing, in the same transaction: it fills in the colour of that
 * user's entries that named the food and were still waiting for one, see colourWaitingEntries
 * below. That is here rather than in the three routes that write one, PUT
 * /foods/{id}/classification, POST /foods/unclassified/confirm and the AI confirm and reject to
 * come, because this module exposes one write and therefore there is no second door a caller
 * could come through having forgotten. See docs/adr/011-an-entry-is-a-colour.md.
 */
export function insertClassifications(
  db: Db,
  verdicts: readonly NewClassification[],
): FoodClassificationRecord[] {
  if (verdicts.length === 0) {
    return [];
  }

  return db.transaction((tx) => {
    const stored = tx
      .insert(foodClassificationTable)
      .values([...verdicts])
      .returning()
      .all();

    for (const verdict of stored) {
      if (verdict.source === 'user' && verdict.userId !== null) {
        colourWaitingEntries(tx, verdict.foodId, verdict.userId, verdict.category);
      }
    }

    return stored;
  });
}

/**
 * Gives this user's still uncoloured entries for one food the colour they were waiting for.
 *
 * Three conditions, and each of them is a rule rather than an optimisation.
 *
 * `category IS NULL` is what makes a logged colour history: an entry that already carries one is
 * never rewritten, whatever the source and whoever says so. Recolouring a food changes what
 * logging it again would give you and leaves every day it was already eaten on alone.
 *
 * The correlated subquery on `meal.user_id` is what makes cross-user isolation hold by
 * construction rather than by a filter somebody could forget: the rows this can reach are the
 * ones whose meal belongs to the user whose verdict this is, so the other household member's
 * waiting entries are not in range at all.
 *
 * And only a `user` source reaches this at all, see the caller. A seed or a model verdict is an
 * opinion about the catalog, not about what somebody ate, so it never writes here.
 */
function colourWaitingEntries(
  // A transaction rather than the connection, which is everything a Db is but its driver handle.
  db: Omit<Db, '$client'>,
  foodId: string,
  userId: string,
  category: Category,
): void {
  db.update(entryTable)
    .set({ category })
    .where(
      and(
        eq(entryTable.foodId, foodId),
        isNull(entryTable.category),
        exists(
          db
            .select({ present: sql`1` })
            .from(mealTable)
            .where(and(eq(mealTable.id, entryTable.mealId), eq(mealTable.userId, userId))),
        ),
      ),
    )
    .run();
}

/**
 * Every verdict on these foods that this user may see, in one query rather than one per food,
 * and with the caller's own verdict left out of it wherever they have withdrawn it since. That
 * exclusion is what resolveClassification needs to fall back to the AI or seed verdict, and it
 * is deliberately not in findClassificationHistory: a withdrawn verdict is still a verdict that
 * was made, and the history is the log itself, unresolved.
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
    .where(
      and(
        inArray(foodClassificationTable.foodId, [...foodIds]),
        visibleTo(userId),
        or(not(eq(foodClassificationTable.source, 'user')), notExists(withdrawnSince(db, userId))),
      ),
    )
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
