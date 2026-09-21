import type { FoodKind } from '@portionium/schemas';
import { and, eq, gt, inArray, isNull, notExists, or, sql } from 'drizzle-orm';

import { normalizeFoodName } from '../domain/food.js';
import type { Db } from './client.js';
import { entryTable, foodClassificationTable, foodTable } from './schema/index.js';

export type FoodRecord = typeof foodTable.$inferSelect;

export interface NewFood {
  name: string;
  kind: FoodKind;
  energyDensity?: number | undefined;
  createdBy: string | null;
}

export interface FoodChanges {
  name?: string | undefined;
  kind?: FoodKind | undefined;
}

export interface FoodListFilters {
  userId: string;
  limit: number;
  cursor?: string | undefined;
  kind?: FoodKind | undefined;
  unclassified?: boolean | undefined;
  mine?: boolean | undefined;
}

export function visibleClassifications(db: Db, userId: string) {
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
  if (filters.mine === true) {
    conditions.push(eq(foodTable.createdBy, filters.userId));
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

export function findFoodByName(db: Omit<Db, '$client'>, name: string): FoodRecord | undefined {
  const target = normalizeFoodName(name);

  return db
    .select()
    .from(foodTable)
    .where(isNull(foodTable.deletedAt))
    .all()
    .find((row) => normalizeFoodName(row.name) === target);
}

export function insertFood(db: Omit<Db, '$client'>, food: NewFood): FoodRecord {
  return db.insert(foodTable).values(food).returning().get();
}

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

/**
 * A food somebody added is removed outright: `entry.food_id` is `ON DELETE SET NULL`, so the meals
 * that named it keep their entries and the colour those were logged with, and lose only the name.
 * A seed food is marked instead, because seedFoodCatalog() reads that mark to keep a catalog entry
 * somebody removed from coming back on the next start.
 */
export function removeFood(db: Db, food: FoodRecord): boolean {
  if (food.createdBy === null) {
    return softDeleteFood(db, food.id);
  }

  return db.transaction((tx) => {
    // Nulling the food id of an entry that was never given a colour would leave a row that is
    // neither a food nor a colour, which entry_food_or_category refuses and which nothing could
    // render. There is nothing left to say about those, so they go with it.
    tx.delete(entryTable)
      .where(and(eq(entryTable.foodId, food.id), isNull(entryTable.category)))
      .run();

    return (
      tx
        .delete(foodTable)
        .where(eq(foodTable.id, food.id))
        .returning({ id: foodTable.id })
        .get() !== undefined
    );
  });
}

function softDeleteFood(db: Db, id: string): boolean {
  return (
    db
      .update(foodTable)
      .set({ deletedAt: new Date() })
      .where(and(eq(foodTable.id, id), isNull(foodTable.deletedAt)))
      .returning({ id: foodTable.id })
      .get() !== undefined
  );
}

export function findExistingFoodIds(db: Db, ids: readonly string[]): Set<string> {
  if (ids.length === 0) {
    return new Set();
  }

  const rows = db
    .select({ id: foodTable.id })
    .from(foodTable)
    .where(and(inArray(foodTable.id, [...new Set(ids)]), isNull(foodTable.deletedAt)))
    .all();

  return new Set(rows.map((row) => row.id));
}

export function findFoodsByIds(db: Db, ids: readonly string[]): FoodRecord[] {
  if (ids.length === 0) {
    return [];
  }

  const unique = [...new Set(ids)];
  const rows = db
    .select()
    .from(foodTable)
    .where(and(inArray(foodTable.id, unique), isNull(foodTable.deletedAt)))
    .all();

  const byId = new Map(rows.map((row) => [row.id, row]));

  return unique.flatMap((id) => {
    const row = byId.get(id);
    return row === undefined ? [] : [row];
  });
}
