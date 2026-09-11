import type { MealType } from '@portionium/schemas';
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, lte } from 'drizzle-orm';

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
 * column default mint one. A supplied id that already belongs to a live row resolves to nothing
 * rather than throwing, so the caller reads back undefined and answers a clear conflict instead
 * of silently overwriting somebody's meal.
 *
 * A supplied id that belongs to the caller's own soft deleted row is the exception: `set` below
 * revives it with this call's fields, which is the whole of how a delete is undone. A client
 * that resends the payload it just deleted, with the id it was given, gets the meal back rather
 * than a conflict. The `where` on the conflict clause is what keeps that narrow: a live row, or
 * a soft deleted row belonging to somebody else, is left untouched and resolves to nothing, the
 * same as `onConflictDoNothing` would, per SQLite's own semantics for a DO UPDATE whose WHERE
 * does not match.
 */
export function insertMeal(
  db: Db,
  meal: ValidatedMeal['meal'] & { id?: string },
  items: readonly ValidatedMealItem[],
): { meal: MealRecord; items: MealItemRecord[] } | undefined {
  return db.transaction((tx) => {
    const stored = tx
      .insert(mealTable)
      .values(meal)
      .onConflictDoUpdate({
        target: mealTable.id,
        set: { ...meal, deletedAt: null },
        // Two literal conditions, never undefined; the assertion is for exactOptionalPropertyTypes,
        // which onConflictDoUpdate's config type does not itself account for.
        where: and(eq(mealTable.userId, meal.userId), isNotNull(mealTable.deletedAt))!,
      })
      .returning()
      .get();
    if (stored === undefined) {
      return undefined;
    }

    // Whatever this id pointed at before is gone either way: nothing for a fresh id, the old
    // item list for a revived one. A meal is never left holding a mix of the two.
    tx.delete(mealItemTable).where(eq(mealItemTable.mealId, stored.id)).run();

    const storedItems = tx
      .insert(mealItemTable)
      .values(items.map((item) => ({ ...item, mealId: stored.id })))
      .returning()
      .all();

    return { meal: stored, items: storedItems };
  });
}

/** One meal the caller owns and has not deleted, or undefined for a missing or foreign one. */
export function findMealById(db: Db, userId: string, id: string): MealRecord | undefined {
  return db
    .select()
    .from(mealTable)
    .where(and(eq(mealTable.id, id), eq(mealTable.userId, userId), isNull(mealTable.deletedAt)))
    .get();
}

/**
 * Replaces a meal's fields and its whole item list in one transaction, the same all-or-nothing
 * guarantee insertMeal gives a create. Items are deleted and reinserted rather than diffed
 * against what is already there, which is what lets a caller add, remove and reorder in one
 * call: the array it sent is the array that ends up stored, position and all.
 */
export function updateMeal(
  db: Db,
  userId: string,
  id: string,
  meal: ValidatedMeal['meal'],
  items: readonly ValidatedMealItem[],
): { meal: MealRecord; items: MealItemRecord[] } | undefined {
  return db.transaction((tx) => {
    const stored = tx
      .update(mealTable)
      .set(meal)
      .where(and(eq(mealTable.id, id), eq(mealTable.userId, userId), isNull(mealTable.deletedAt)))
      .returning()
      .get();
    if (stored === undefined) {
      return undefined;
    }

    tx.delete(mealItemTable).where(eq(mealItemTable.mealId, id)).run();
    const storedItems = tx
      .insert(mealItemTable)
      .values(items.map((item) => ({ ...item, mealId: id })))
      .returning()
      .all();

    return { meal: stored, items: storedItems };
  });
}

/** False when there was nothing live to delete, so deleting twice is a 404 rather than a 204. */
export function softDeleteMeal(db: Db, userId: string, id: string): boolean {
  return (
    db
      .update(mealTable)
      .set({ deletedAt: new Date() })
      .where(and(eq(mealTable.id, id), eq(mealTable.userId, userId), isNull(mealTable.deletedAt)))
      .returning({ id: mealTable.id })
      .get() !== undefined
  );
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
