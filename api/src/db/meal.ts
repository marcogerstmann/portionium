import type { Category, MealType } from '@portionium/schemas';
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, lte } from 'drizzle-orm';

import type { ValidatedEntry, ValidatedMeal } from '../domain/meal.js';
import type { Db } from './client.js';
import { entryTable, mealTable } from './schema/index.js';

export type MealRecord = typeof mealTable.$inferSelect;
export type EntryRecord = typeof entryTable.$inferSelect;

export interface MealListFilters {
  userId: string;
  limit: number;
  cursor?: string | undefined;
  type?: MealType | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

export function insertMeal(
  db: Db,
  meal: ValidatedMeal['meal'] & { id?: string },
  entries: readonly ValidatedEntry[],
): { meal: MealRecord; entries: EntryRecord[] } | undefined {
  return db.transaction((tx) => {
    const stored = tx
      .insert(mealTable)
      .values(meal)
      .onConflictDoUpdate({
        target: mealTable.id,
        set: { ...meal, deletedAt: null },
        where: and(eq(mealTable.userId, meal.userId), isNotNull(mealTable.deletedAt))!,
      })
      .returning()
      .get();
    if (stored === undefined) {
      return undefined;
    }

    tx.delete(entryTable).where(eq(entryTable.mealId, stored.id)).run();

    const storedEntries = tx
      .insert(entryTable)
      .values(entries.map((entry) => ({ ...entry, mealId: stored.id })))
      .returning()
      .all();

    return { meal: stored, entries: storedEntries };
  });
}

export function findMealById(db: Db, userId: string, id: string): MealRecord | undefined {
  return db
    .select()
    .from(mealTable)
    .where(and(eq(mealTable.id, id), eq(mealTable.userId, userId), isNull(mealTable.deletedAt)))
    .get();
}

export function updateMeal(
  db: Db,
  userId: string,
  id: string,
  meal: ValidatedMeal['meal'],
  entries: readonly ValidatedEntry[],
): { meal: MealRecord; entries: EntryRecord[] } | undefined {
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

    tx.delete(entryTable).where(eq(entryTable.mealId, id)).run();
    const storedEntries = tx
      .insert(entryTable)
      .values(entries.map((entry) => ({ ...entry, mealId: id })))
      .returning()
      .all();

    return { meal: stored, entries: storedEntries };
  });
}

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

export function findEntriesForDateRange(
  db: Db,
  userId: string,
  from: string,
  to: string,
): { category: Category | null; localDate: string }[] {
  return db
    .select({ category: entryTable.category, localDate: mealTable.localDate })
    .from(entryTable)
    .innerJoin(mealTable, eq(mealTable.id, entryTable.mealId))
    .where(
      and(
        eq(mealTable.userId, userId),
        isNull(mealTable.deletedAt),
        gte(mealTable.localDate, from),
        lte(mealTable.localDate, to),
      ),
    )
    .all();
}

export function findEntriesForMeals(db: Db, mealIds: readonly string[]): EntryRecord[] {
  if (mealIds.length === 0) {
    return [];
  }

  return db
    .select()
    .from(entryTable)
    .where(inArray(entryTable.mealId, [...mealIds]))
    .orderBy(entryTable.position)
    .all();
}
