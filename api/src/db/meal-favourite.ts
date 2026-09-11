import type { MealItemInput, MealType } from '@portionium/schemas';
import { and, desc, eq, isNull, lt } from 'drizzle-orm';

import type { Db } from './client.js';
import { mealFavouriteTable } from './schema/index.js';

/** Every query a favourite needs. Reads are always scoped to `userId`, favourites are private. */

export type MealFavouriteRecord = typeof mealFavouriteTable.$inferSelect;

export interface NewMealFavourite {
  userId: string;
  name: string;
  type: MealType;
  items: readonly MealItemInput[];
}

export function insertMealFavourite(db: Db, favourite: NewMealFavourite): MealFavouriteRecord {
  return db
    .insert(mealFavouriteTable)
    .values({ ...favourite, items: [...favourite.items] })
    .returning()
    .get();
}

export interface MealFavouriteListFilters {
  userId: string;
  limit: number;
  cursor?: string | undefined;
  type?: MealType | undefined;
}

/** A page of a caller's own favourites, newest first, the same convention listMeals follows. */
export function listMealFavourites(
  db: Db,
  filters: MealFavouriteListFilters,
): MealFavouriteRecord[] {
  const conditions = [
    eq(mealFavouriteTable.userId, filters.userId),
    isNull(mealFavouriteTable.deletedAt),
  ];

  if (filters.cursor !== undefined) {
    conditions.push(lt(mealFavouriteTable.id, filters.cursor));
  }
  if (filters.type !== undefined) {
    conditions.push(eq(mealFavouriteTable.type, filters.type));
  }

  return db
    .select()
    .from(mealFavouriteTable)
    .where(and(...conditions))
    .orderBy(desc(mealFavouriteTable.id))
    .limit(filters.limit)
    .all();
}

/** False when there was nothing live to delete, so deleting twice is a 404 rather than a 204. */
export function softDeleteMealFavourite(db: Db, userId: string, id: string): boolean {
  return (
    db
      .update(mealFavouriteTable)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(mealFavouriteTable.id, id),
          eq(mealFavouriteTable.userId, userId),
          isNull(mealFavouriteTable.deletedAt),
        ),
      )
      .returning({ id: mealFavouriteTable.id })
      .get() !== undefined
  );
}
