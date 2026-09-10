import { and, count, desc, eq, getTableColumns, inArray, isNull, sql } from 'drizzle-orm';

import {
  looselyMatches,
  rankSearchResults,
  toFtsMatch,
  type SearchCandidate,
} from '../domain/food-search.js';
import type { Db } from './client.js';
import type { FoodRecord } from './food.js';
import { foodTable, mealItemTable, mealTable } from './schema/index.js';

/**
 * Finding a food, which is on the critical path of the only interaction this app has. If
 * typing "Skyr" is not instant, nothing else about the product matters.
 *
 * Three steps, and they are separate on purpose:
 *
 *   Recall asks which entries could be meant, and is the only part that has to scale. It is an
 *   FTS5 index over the names, tokenised into trigrams, so a query matches inside a word and
 *   across a space: `kyr` finds `Skyr` and `nut but` finds `Peanut Butter`. The index is kept
 *   in step with the food table by triggers, see 0005_add_food_search_index.sql, so nothing in
 *   this codebase has to remember to write to it.
 *
 *   Enrichment asks how much each candidate is actually eaten, by the caller and by everybody.
 *   Two grouped queries over meal_item rather than one correlated subquery per candidate.
 *
 *   Ranking decides what somebody meant, and is domain/food-search.ts, in memory, over the
 *   rows that came back.
 *
 * Soft deleted foods never appear. They stay in the index, because a delete is an update to a
 * column the trigger does not watch, and the join in enrichFoods is what drops them: the
 * catalog's read path already has to filter them and one filter is easier to trust than two.
 */

/** A catalog row with the two numbers ranking is decided on. */
export type SearchResult = FoodRecord & SearchCandidate;

/**
 * How many index hits are considered before ranking. A three character query against a large
 * catalog can match most of it, and every hit costs a row in the enrichment queries.
 *
 * ponytail: a flat cap, taken in the index's own relevance order, so the entries cut off are
 * the least lexically similar ones. It can in principle drop a food the caller eats daily,
 * which ranking would have put first. If that is ever observed rather than imagined, the fix
 * is to union this with the caller's own frequently eaten matches before ranking.
 */
const RECALL_LIMIT = 500;

/**
 * The caller's own history with each food: how often, and how recently.
 *
 * Soft deleted meals are excluded, which is the opposite of what countMealsUsingFood does, and
 * the two are answering different questions. That one asks whether a food may be removed from
 * a shared catalog, where a deleted meal still has a row pointing at it. This one asks what
 * somebody eats, and a meal they deleted is a meal they are saying they did not.
 */
function userStats(db: Db, userId: string) {
  return db
    .select({
      foodId: mealItemTable.foodId,
      uses: count().as('user_uses'),
      lastUsedAt: sql<number | null>`max(${mealTable.loggedAt})`.as('user_last_used_at'),
    })
    .from(mealItemTable)
    .innerJoin(mealTable, eq(mealTable.id, mealItemTable.mealId))
    .where(and(eq(mealTable.userId, userId), isNull(mealTable.deletedAt)))
    .groupBy(mealItemTable.foodId)
    .as('user_stats');
}

/** The same question asked of the whole instance, which is what "popular" means here. */
function globalStats(db: Db) {
  return db
    .select({ foodId: mealItemTable.foodId, uses: count().as('global_uses') })
    .from(mealItemTable)
    .innerJoin(mealTable, eq(mealTable.id, mealItemTable.mealId))
    .where(isNull(mealTable.deletedAt))
    .groupBy(mealItemTable.foodId)
    .as('global_stats');
}

/**
 * Candidate ids from the trigram index, in its own relevance order.
 *
 * Raw SQL because MATCH and the rank ordering are FTS5's, and the virtual table behind them is
 * not something Drizzle's schema can describe. The query string arrives as a bound parameter
 * and has been through toFtsMatch, so it is one quoted phrase rather than an expression a user
 * can write.
 */
function recallByIndex(db: Db, match: string): string[] {
  return db
    .all<{ food_id: string }>(
      sql`select food_id from food_search where food_search match ${match} order by rank limit ${RECALL_LIMIT}`,
    )
    .map((row) => row.food_id);
}

/**
 * Candidates the index could not have found: a query too short for a trigram, and a name a
 * single typo away from one.
 *
 * A scan of the live names, in JavaScript, for the same reason findFoodByName is one: case
 * folding and the comparison itself have to happen where `Müsli` and `MÜSLI` are one word,
 * which SQLite without ICU is not.
 *
 * ponytail: linear over the catalog, a few hundred rows today and bounded by how many foods an
 * instance has rather than by how many meals it logs. It runs only when the index came back
 * with less than a full page, which for a query anybody actually types is never. If a catalog
 * grows to where this shows up, the answer is a second FTS5 table over a phonetic or
 * transposed form of each name, not a faster scan.
 */
function recallByScan(db: Db, query: string, exclude: ReadonlySet<string>): string[] {
  return db
    .select({ id: foodTable.id, name: foodTable.name })
    .from(foodTable)
    .where(isNull(foodTable.deletedAt))
    .all()
    .filter((row) => !exclude.has(row.id) && looselyMatches(row.name, query))
    .map((row) => row.id);
}

/** The candidate rows, with the usage each one is ranked on. Deleted entries drop out here. */
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

/**
 * What an empty search box should show, which is not an error and not the top of the alphabet.
 *
 * Ordered by how often this user eats each food, then by how often the instance does, then by
 * name. Written as one ordering rather than three lookups because the degradation is the
 * point: a user with history sees their own foods, a new account on an established instance
 * sees what gets eaten there, and a fresh install still answers with a usable list instead of
 * nothing. Null sorts last under DESC in SQLite, so a food nobody has eaten needs no coalesce.
 */
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
  /** Whose history personalises the ranking. Never which foods are visible, the catalog is shared. */
  userId: string;
  /** Empty means "show me the useful default", which is what an autocomplete opens with. */
  query: string;
  limit: number;
}

/** The whole of search: recall, enrich, rank, cut to a page. Ordered, ready to serialise. */
export function searchFoods(db: Db, { userId, query, limit }: FoodSearchQuery): SearchResult[] {
  if (query.trim() === '') {
    return frequentFoods(db, userId, limit);
  }

  const match = toFtsMatch(query);
  const ids = match === undefined ? [] : recallByIndex(db, match);

  // The scan is what covers the two cases the trigram index is blind to, a query shorter than
  // one trigram and a name a typo away from the query. Skipped entirely once the index has
  // already found a full page, which is the ordinary case.
  const candidates = ids.length >= limit ? ids : [...ids, ...recallByScan(db, query, new Set(ids))];

  return rankSearchResults(enrichFoods(db, candidates, userId), query).slice(0, limit);
}
