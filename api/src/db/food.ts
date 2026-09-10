import type { FoodKind } from '@portionium/schemas';
import { and, count, eq, gt, inArray, isNull, notExists, or, sql } from 'drizzle-orm';

import { normalizeFoodName } from '../domain/food.js';
import type { Db } from './client.js';
import { foodClassificationTable, foodTable, mealItemTable } from './schema/index.js';

/**
 * Every query the catalog needs.
 *
 * The catalog is shared, so unlike every other repository in this codebase these reads are not
 * filtered by owner: one entry for "Skyr" serves the whole instance, which is the point of a
 * single table, see docs/adr/006-single-foods-table.md. What is per user is the colour, so a
 * `userId` still goes into most of these, to decide which verdicts the caller is allowed to be
 * shown rather than which foods.
 *
 * Soft deleted foods never come back from anything here. A meal that names one keeps its row,
 * which is the reason a food in use cannot be deleted at all.
 */

export type FoodRecord = typeof foodTable.$inferSelect;
export type FoodClassificationRecord = typeof foodClassificationTable.$inferSelect;

export interface NewFood {
  name: string;
  kind: FoodKind;
  energyDensity?: number | undefined;
  /** Null for the entries that ship with the app. A shared catalog's seeds are nobody's. */
  createdBy: string | null;
}

/** Undefined means untouched, the same convention updateUserProfile uses. */
export interface FoodChanges {
  name?: string | undefined;
  kind?: FoodKind | undefined;
}

export interface FoodListFilters {
  /** Whose verdicts count, when `unclassified` asks whether there are any. */
  userId: string;
  limit: number;
  cursor?: string | undefined;
  kind?: FoodKind | undefined;
  unclassified?: boolean | undefined;
}

/**
 * The verdicts on one food that this user is allowed to see: the shared ones and their own.
 * Correlated with the outer query, so it can be asked as an existence test without a join that
 * would multiply rows.
 */
function visibleClassifications(db: Db, userId: string) {
  return db
    .select({ present: sql`1` })
    .from(foodClassificationTable)
    .where(
      and(
        eq(foodClassificationTable.foodId, foodTable.id),
        or(isNull(foodClassificationTable.userId), eq(foodClassificationTable.userId, userId)),
      ),
    );
}

/**
 * A page of the catalog, oldest id first.
 *
 * Ascending rather than newest first, which is what the lists of a user's own rows do. Those
 * are a feed and the interesting end is the recent one; this is a catalog, where the seeded
 * entries are the ones somebody browsing wants first and a new entry belongs at the back.
 * Either way ids are UUIDv7, so the id both orders the page and addresses the next one.
 *
 * `unclassified` is answered in SQL rather than by resolving a page and filtering it. The four
 * classification sources are exactly the three buckets resolveClassification looks in, so "no
 * verdict resolves for this user" and "no verdict is visible to this user" are the same
 * question, and asking the cheap one keeps a page of fifty a page of fifty.
 */
export function listFoods(db: Db, filters: FoodListFilters): FoodRecord[] {
  const conditions = [isNull(foodTable.deletedAt)];

  if (filters.cursor !== undefined) {
    conditions.push(gt(foodTable.id, filters.cursor));
  }
  if (filters.kind !== undefined) {
    conditions.push(eq(foodTable.kind, filters.kind));
  }
  if (filters.unclassified === true) {
    conditions.push(notExists(visibleClassifications(db, filters.userId)));
  }

  return db
    .select()
    .from(foodTable)
    .where(and(...conditions))
    .orderBy(foodTable.id)
    .limit(filters.limit)
    .all();
}

export function findFoodById(db: Db, id: string): FoodRecord | undefined {
  return db
    .select()
    .from(foodTable)
    .where(and(eq(foodTable.id, id), isNull(foodTable.deletedAt)))
    .get();
}

/**
 * The entry this name already refers to, if there is one.
 *
 * Matched on the normalised form of both sides, in JavaScript, which means reading the live
 * catalog to do it. That is deliberate: SQLite's `lower()` is ASCII only without ICU, so a
 * comparison done in SQL would file `Müsli` and `MÜSLI` as two foods, and no index expression
 * can collapse the run of spaces in `Peanut  Butter` either. See normalizeFoodName.
 *
 * ponytail: linear over the live catalog, which is a few hundred rows and is read once per
 * create. If the catalog reaches a size where that shows up, store the normalised form in its
 * own indexed column and backfill it at boot, in JavaScript, for the same reason as above.
 */
export function findFoodByName(db: Db, name: string): FoodRecord | undefined {
  const target = normalizeFoodName(name);

  return db
    .select()
    .from(foodTable)
    .where(isNull(foodTable.deletedAt))
    .all()
    .find((row) => normalizeFoodName(row.name) === target);
}

export function insertFood(db: Db, food: NewFood): FoodRecord {
  return db.insert(foodTable).values(food).returning().get();
}

/**
 * Name and kind, and deliberately nothing else. A colour is a verdict with an author and is
 * written as a classification row, so there is no field here that could carry one.
 */
export function updateFood(db: Db, id: string, changes: FoodChanges): FoodRecord | undefined {
  if (Object.values(changes).every((value) => value === undefined)) {
    return findFoodById(db, id);
  }

  return db
    .update(foodTable)
    .set(changes)
    .where(and(eq(foodTable.id, id), isNull(foodTable.deletedAt)))
    .returning()
    .get();
}

/** False when there was nothing live to delete, so deleting twice is a 404 rather than a 204. */
export function softDeleteFood(db: Db, id: string): boolean {
  return (
    db
      .update(foodTable)
      .set({ deletedAt: new Date() })
      .where(and(eq(foodTable.id, id), isNull(foodTable.deletedAt)))
      .returning({ id: foodTable.id })
      .get() !== undefined
  );
}

/**
 * How many meal items name this food. Soft deleted meals are counted too: their items are still
 * rows pointing here, and a meal that can be looked at in a history is a meal whose foods have
 * to still resolve.
 */
export function countMealsUsingFood(db: Db, foodId: string): number {
  return (
    db.select({ value: count() }).from(mealItemTable).where(eq(mealItemTable.foodId, foodId)).get()
      ?.value ?? 0
  );
}

/**
 * Every verdict on these foods that this user may see, in one query rather than one per food.
 * Resolution happens over the result, in domain/classification.ts, which is the only place the
 * order of precedence is written down.
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
        or(isNull(foodClassificationTable.userId), eq(foodClassificationTable.userId, userId)),
      ),
    )
    .all();
}
