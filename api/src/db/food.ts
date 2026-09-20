import type { FoodKind } from '@portionium/schemas';
import { and, count, eq, gt, inArray, isNull, notExists, or, sql } from 'drizzle-orm';

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

export function countMealsUsingFood(db: Db, foodId: string): number {
  return (
    db.select({ value: count() }).from(entryTable).where(eq(entryTable.foodId, foodId)).get()
      ?.value ?? 0
  );
}
