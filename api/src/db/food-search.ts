import { and, count, desc, eq, getTableColumns, inArray, isNull, sql } from 'drizzle-orm';

import {
  looselyMatches,
  rankSearchResults,
  toFtsMatch,
  type SearchCandidate,
} from '../domain/food-search.js';
import type { Db } from './client.js';
import type { FoodRecord } from './food.js';
import { entryTable, foodTable, mealTable } from './schema/index.js';

export type SearchResult = FoodRecord & SearchCandidate;

const RECALL_LIMIT = 500;

function userStats(db: Db, userId: string) {
  return db
    .select({
      foodId: entryTable.foodId,
      uses: count().as('user_uses'),
      lastUsedAt: sql<number | null>`max(${mealTable.loggedAt})`.as('user_last_used_at'),
    })
    .from(entryTable)
    .innerJoin(mealTable, eq(mealTable.id, entryTable.mealId))
    .where(and(eq(mealTable.userId, userId), isNull(mealTable.deletedAt)))
    .groupBy(entryTable.foodId)
    .as('user_stats');
}

function globalStats(db: Db) {
  return db
    .select({ foodId: entryTable.foodId, uses: count().as('global_uses') })
    .from(entryTable)
    .innerJoin(mealTable, eq(mealTable.id, entryTable.mealId))
    .where(isNull(mealTable.deletedAt))
    .groupBy(entryTable.foodId)
    .as('global_stats');
}

function recallByIndex(db: Db, match: string): string[] {
  return db
    .all<{ food_id: string }>(
      sql`select food_id from food_search where food_search match ${match} order by rank limit ${RECALL_LIMIT}`,
    )
    .map((row) => row.food_id);
}

function recallByScan(db: Db, query: string, exclude: ReadonlySet<string>): string[] {
  return db
    .select({ id: foodTable.id, name: foodTable.name })
    .from(foodTable)
    .where(isNull(foodTable.deletedAt))
    .all()
    .filter((row) => !exclude.has(row.id) && looselyMatches(row.name, query))
    .map((row) => row.id);
}

function enrichFoods(db: Db, ids: readonly string[], userId: string): SearchResult[] {
  if (ids.length === 0) {
    return [];
  }

  const mine = userStats(db, userId);
  const everyone = globalStats(db);

  return db
    .select({
      ...getTableColumns(foodTable),
      lastUsedAt: mine.lastUsedAt,
      uses: everyone.uses,
    })
    .from(foodTable)
    .leftJoin(mine, eq(mine.foodId, foodTable.id))
    .leftJoin(everyone, eq(everyone.foodId, foodTable.id))
    .where(and(inArray(foodTable.id, [...ids]), isNull(foodTable.deletedAt)))
    .all()
    .map((row) => ({
      ...row,
      lastUsedAt: row.lastUsedAt === null ? null : new Date(row.lastUsedAt),
      uses: row.uses ?? 0,
    }));
}

function frequentFoods(db: Db, userId: string, limit: number): SearchResult[] {
  const mine = userStats(db, userId);
  const everyone = globalStats(db);

  return db
    .select({
      ...getTableColumns(foodTable),
      lastUsedAt: mine.lastUsedAt,
      uses: everyone.uses,
      mineUses: mine.uses,
    })
    .from(foodTable)
    .leftJoin(mine, eq(mine.foodId, foodTable.id))
    .leftJoin(everyone, eq(everyone.foodId, foodTable.id))
    .where(isNull(foodTable.deletedAt))
    .orderBy(desc(mine.uses), desc(everyone.uses), foodTable.name)
    .limit(limit)
    .all()
    .map(({ mineUses: _mineUses, ...row }) => ({
      ...row,
      lastUsedAt: row.lastUsedAt === null ? null : new Date(row.lastUsedAt),
      uses: row.uses ?? 0,
    }));
}

export interface FoodSearchQuery {
  userId: string;
  query: string;
  limit: number;
}

export function searchFoods(db: Db, { userId, query, limit }: FoodSearchQuery): SearchResult[] {
  if (query.trim() === '') {
    return frequentFoods(db, userId, limit);
  }

  const match = toFtsMatch(query);
  const ids = match === undefined ? [] : recallByIndex(db, match);

  // Covers what the trigram index is blind to, a query under three characters and a typo. Skipped
  // when the index already returned a full page, which is the ordinary case.
  const candidates = ids.length >= limit ? ids : [...ids, ...recallByScan(db, query, new Set(ids))];

  return rankSearchResults(enrichFoods(db, candidates, userId), query).slice(0, limit);
}
