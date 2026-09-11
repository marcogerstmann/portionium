import { and, count, eq, inArray, isNull, lt, notExists } from 'drizzle-orm';

import { resolveClassifications } from '../domain/classification.js';
import {
  findClassificationsForFoods,
  visibleTo,
  type FoodClassificationRecord,
} from './classification.js';
import type { Db } from './client.js';
import { visibleClassifications, type FoodRecord } from './food.js';
import { foodClassificationTable, foodTable, mealItemTable, mealTable } from './schema/index.js';

/**
 * The human-in-the-loop queue, see POR-30 and docs/adr/007-append-only-classification-log.md.
 *
 * A food belongs here for one of two reasons: nothing visible to this caller resolves to a
 * colour at all, or the winning verdict is an AI guess too unsure to stand on its own. The first
 * case is exactly what `unclassified` on GET /foods already answers in SQL, see
 * visibleClassifications in food.ts. The second only exists once `minConfidence` is asked for,
 * and needs resolveClassification's own priority order run in memory: a low confidence AI guess
 * that a user has since overridden is not pending, it is answered.
 */
const MODEL_SOURCES = new Set(['ai_text', 'ai_vision']);

function isModelVerdict(row: FoodClassificationRecord): boolean {
  return MODEL_SOURCES.has(row.source);
}

/**
 * Every pending food id for this caller, mapped to the AI suggestion behind it where one
 * exists. Undefined means nobody, human or model, has said anything about this food at all.
 *
 * `minConfidence` is optional and changes what counts as pending: left out, only a food with no
 * visible verdict qualifies. Given, a food whose winning verdict is a low confidence AI guess
 * qualifies too, found by first asking SQL which foods have such a row at all and only then
 * running resolution over their full history, so a user override or a later confident guess
 * takes it back out of the queue without this function reimplementing that priority order.
 */
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

  // Candidates, not answers: a food can have a low confidence AI row and still resolve to
  // something else, a user override or a newer, more confident guess. Only the ids come from
  // SQL, the winner comes from resolveClassifications the same as everywhere else.
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

/**
 * How often the caller has eaten each of these foods, for the ids already known to be pending.
 * The same question food-search.ts asks of the whole catalog, asked here of a handful of ids.
 */
function usageCounts(db: Db, userId: string, foodIds: readonly string[]): Map<string, number> {
  const rows = db
    .select({ foodId: mealItemTable.foodId, uses: count() })
    .from(mealItemTable)
    .innerJoin(mealTable, eq(mealTable.id, mealItemTable.mealId))
    .where(
      and(
        eq(mealTable.userId, userId),
        isNull(mealTable.deletedAt),
        inArray(mealItemTable.foodId, [...foodIds]),
      ),
    )
    .groupBy(mealItemTable.foodId)
    .all();

  return new Map(rows.map((row) => [row.foodId, row.uses]));
}

/**
 * The queue itself: pending foods, ordered by how often the caller eats each one, most first.
 * Not a page, the same reasoning as searchFoods: this is a ranking, meaningful only from the
 * top, not a list somebody scrolls to the bottom of.
 */
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

/**
 * The badge count. With no `minConfidence` this is a single SQL count, which is what "cheap"
 * means in the ticket: a client can poll this on every app open without paying for the join
 * and the sort listUnclassifiedFoods does. `minConfidence` given, it costs what the list costs
 * minus the enrichment, because the resolution step cannot be skipped without reimplementing it.
 */
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
