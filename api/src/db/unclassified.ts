import { and, count, eq, inArray, isNull, lt, notExists } from 'drizzle-orm';

import { resolveClassifications } from '../domain/classification.js';
import {
  findClassificationsForFoods,
  visibleTo,
  type FoodClassificationRecord,
} from './classification.js';
import type { Db } from './client.js';
import { visibleClassifications, type FoodRecord } from './food.js';
import { entryTable, foodClassificationTable, foodTable, mealTable } from './schema/index.js';

const MODEL_SOURCES = new Set(['ai_text', 'ai_vision']);

function isModelVerdict(row: FoodClassificationRecord): boolean {
  return MODEL_SOURCES.has(row.source);
}

export function findPendingFoods(
  db: Db,
  userId: string,
  minConfidence: number | undefined,
): Map<string, FoodClassificationRecord | undefined> {
  const pending = new Map<string, FoodClassificationRecord | undefined>();

  const unjudged = db
    .select({ id: foodTable.id })
    .from(foodTable)
    .where(and(isNull(foodTable.deletedAt), notExists(visibleClassifications(db, userId))))
    .all();
  for (const row of unjudged) {
    pending.set(row.id, undefined);
  }

  if (minConfidence === undefined) {
    return pending;
  }

  const candidateIds = db
    .selectDistinct({ foodId: foodClassificationTable.foodId })
    .from(foodClassificationTable)
    .where(
      and(
        inArray(foodClassificationTable.source, ['ai_text', 'ai_vision']),
        lt(foodClassificationTable.confidence, minConfidence),
        visibleTo(userId),
      ),
    )
    .all()
    .map((row) => row.foodId)
    .filter((id) => !pending.has(id));

  if (candidateIds.length === 0) {
    return pending;
  }

  const resolved = resolveClassifications(
    findClassificationsForFoods(db, candidateIds, userId),
    userId,
  );
  for (const foodId of candidateIds) {
    const winner = resolved.get(foodId);
    if (
      winner !== undefined &&
      isModelVerdict(winner) &&
      (winner.confidence ?? 1) < minConfidence
    ) {
      pending.set(foodId, winner);
    }
  }

  return pending;
}

export interface UnclassifiedFilters {
  userId: string;
  minConfidence?: number | undefined;
  limit: number;
}

export interface UnclassifiedFood {
  food: FoodRecord;
  suggestion: FoodClassificationRecord | undefined;
}

function usageCounts(db: Db, userId: string, foodIds: readonly string[]): Map<string, number> {
  const rows = db
    .select({ foodId: entryTable.foodId, uses: count() })
    .from(entryTable)
    .innerJoin(mealTable, eq(mealTable.id, entryTable.mealId))
    .where(
      and(
        eq(mealTable.userId, userId),
        isNull(mealTable.deletedAt),
        inArray(entryTable.foodId, [...foodIds]),
      ),
    )
    .groupBy(entryTable.foodId)
    .all();

  return new Map(rows.flatMap((row) => (row.foodId === null ? [] : [[row.foodId, row.uses]])));
}

export function listUnclassifiedFoods(db: Db, filters: UnclassifiedFilters): UnclassifiedFood[] {
  const pending = findPendingFoods(db, filters.userId, filters.minConfidence);
  if (pending.size === 0) {
    return [];
  }

  const ids = [...pending.keys()];
  const foods = db
    .select()
    .from(foodTable)
    .where(and(inArray(foodTable.id, ids), isNull(foodTable.deletedAt)))
    .all();
  const uses = usageCounts(db, filters.userId, ids);

  return foods
    .map((food) => ({ food, suggestion: pending.get(food.id), uses: uses.get(food.id) ?? 0 }))
    .sort((a, b) => b.uses - a.uses || (a.food.name < b.food.name ? -1 : 1))
    .slice(0, filters.limit)
    .map(({ food, suggestion }) => ({ food, suggestion }));
}

export function countUnclassifiedFoods(
  db: Db,
  filters: { userId: string; minConfidence?: number | undefined },
): number {
  if (filters.minConfidence === undefined) {
    return (
      db
        .select({ value: count() })
        .from(foodTable)
        .where(
          and(isNull(foodTable.deletedAt), notExists(visibleClassifications(db, filters.userId))),
        )
        .get()?.value ?? 0
    );
  }

  return findPendingFoods(db, filters.userId, filters.minConfidence).size;
}
