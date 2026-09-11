import type { MealType } from '@portionium/schemas';
import { and, desc, eq, gte, inArray, isNull, lt, lte } from 'drizzle-orm';

import type { ValidatedMeal, ValidatedMealItem } from '../domain/meal.js';
import type { Db } from './client.js';
import { mealItemTable, mealTable } from './schema/index.js';

/**
 * Every query a meal needs. Reads are always scoped to `userId`, the way every user owned table
 * in this codebase is, and never look at another account's rows.
 */

export type MealRecord = typeof mealTable.$inferSelect;
export type MealItemRecord = typeof mealItemTable.$inferSelect;

export interface MealListFilters {
  userId: string;
  limit: number;
  cursor?: string | undefined;
  type?: MealType | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

/**
 * Stores a validated meal and its items in one transaction, so a meal is never visible without
 * the items it was created with.
 *
 * `id` is the client's own, for a meal logged offline and synced later, or absent to let the
 * column default mint one. Either way this is the one place an id reaches the table, through
 * `onConflictDoNothing`: a supplied id that already belongs to a row makes the insert affect
 * nothing rather than throw, so the caller reads back undefined and answers a clear conflict
 * instead of silently overwriting somebody's meal.
 */
export function insertMeal(
  db: Db,
  meal: ValidatedMeal['meal'] & { id?: string },
  items: readonly ValidatedMealItem[],
): { meal: MealRecord; items: MealItemRecord[] } | undefined {
  return db.transaction((tx) => {
    const stored = tx.insert(mealTable).values(meal).onConflictDoNothing().returning().get();
    if (stored === undefined) {
      return undefined;
    }

    const storedItems = tx
      .insert(mealItemTable)
      .values(items.map((item) => ({ ...item, mealId: stored.id })))
      .returning()
      .all();

    return { meal: stored, items: storedItems };
  });
}

/**
 * A page of a caller's own meals, newest first. Unlike the shared catalog's oldest-first paging
 * in listFoods, this is a feed: the recent end is the interesting one, so the cursor means
 * "older than this" and the id comparison runs the other way.
 */
export function listMeals(db: Db, filters: MealListFilters): MealRecord[] {
  const conditions = [eq(mealTable.userId, filters.userId), isNull(mealTable.deletedAt)];

  if (filters.cursor !== undefined) {
    conditions.push(lt(mealTable.id, filters.cursor));
  }
  if (filters.type !== undefined) {
    conditions.push(eq(mealTable.type, filters.type));
  }
  if (filters.from !== undefined) {
    conditions.push(gte(mealTable.localDate, filters.from));
  }
  if (filters.to !== undefined) {
    conditions.push(lte(mealTable.localDate, filters.to));
  }

  return db
    .select()
    .from(mealTable)
    .where(and(...conditions))
    .orderBy(desc(mealTable.id))
    .limit(filters.limit)
    .all();
}

/**
 * Every meal logged on one local day, chronological. Not paged: a day's worth of meals is a
 * handful, and GET /days/{date} needs the whole of it in one read either way.
 */
export function findMealsForDay(db: Db, userId: string, localDate: string): MealRecord[] {
  return db
    .select()
    .from(mealTable)
    .where(
      and(
        eq(mealTable.userId, userId),
        eq(mealTable.localDate, localDate),
        isNull(mealTable.deletedAt),
      ),
    )
    .orderBy(mealTable.loggedAt)
    .all();
}

/**
 * Every item across a page or a day of meals, in one query rather than one per meal. That is
 * the whole of the performance note on GET /days/{date}: a day with twenty items costs the same
 * round trip as a day with two.
 */
export function findItemsForMeals(db: Db, mealIds: readonly string[]): MealItemRecord[] {
  if (mealIds.length === 0) {
    return [];
  }

  return db
    .select()
    .from(mealItemTable)
    .where(inArray(mealItemTable.mealId, [...mealIds]))
    .orderBy(mealItemTable.position)
    .all();
}
