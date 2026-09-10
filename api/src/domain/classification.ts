import type { Category, ClassificationSource } from '@portionium/schemas';

/**
 * Which verdict wins.
 *
 * A food does not have a colour, it has a stack of opinions about its colour: the one that
 * shipped with the catalog, whatever a model said, and whatever its owner said back. Deciding
 * between them is one function, here, and every read path in the application goes through it,
 * so two endpoints can never disagree about what a user is looking at.
 *
 * The order is the product, stated once:
 *
 *   1. the caller's own most recent verdict
 *   2. the most recent model verdict visible to them
 *   3. the verdict that shipped with the catalog
 *   4. no colour, which is a state and not a failure
 *
 * Nothing is updated or deleted to make this happen. A user changing their mind adds a row, so
 * the disagreement survives and the prompt that produced the original can be measured against
 * it later.
 */

/**
 * The shape resolution actually needs, which is deliberately smaller than a classification row.
 * `userId` is nullable rather than optional because it arrives from a column, and a `Date`
 * because that is what the driver hands back.
 */
export interface ResolvableClassification {
  id: string;
  userId: string | null;
  category: Category;
  source: ClassificationSource;
  createdAt: Date;
}

/** The two sources a model produces. `ai_vision` is reserved for the photo flow. */
const MODEL_SOURCES: ReadonlySet<ClassificationSource> = new Set(['ai_text', 'ai_vision']);

/**
 * Newest first, by the instant and then by the id.
 *
 * The tiebreak is not decoration. Two rows written in the same millisecond are ordinary here,
 * a seed run inserts a few hundred of them, and without a second key the winner would depend
 * on the order SQLite happened to return. Ids are UUIDv7, so comparing them compares creation
 * order, which is the same question the timestamp was asking.
 */
function newest<T extends ResolvableClassification>(rows: readonly T[]): T | undefined {
  return rows.reduce<T | undefined>((best, row) => {
    if (best === undefined) {
      return row;
    }

    const byTime = row.createdAt.getTime() - best.createdAt.getTime();
    return byTime > 0 || (byTime === 0 && row.id > best.id) ? row : best;
  }, undefined);
}

/**
 * The winning verdict for this food and this user, or undefined when nobody has one.
 *
 * Rows belonging to another account are filtered out first rather than relied upon not to be
 * passed in. A caller assembling candidates from a query is one forgotten `where` away from
 * showing one household member the other's opinion, and that is not a mistake this function
 * should be able to have made for it.
 */
export function resolveClassification<T extends ResolvableClassification>(
  candidates: readonly T[],
  userId: string,
): T | undefined {
  const visible = candidates.filter((row) => row.userId === null || row.userId === userId);

  return (
    newest(visible.filter((row) => row.source === 'user' && row.userId === userId)) ??
    newest(visible.filter((row) => MODEL_SOURCES.has(row.source))) ??
    newest(visible.filter((row) => row.source === 'seed'))
  );
}

/**
 * Resolution for a whole page in one pass, keyed by food id.
 *
 * A list endpoint has fifty foods and one bag of classifications for all of them, which is one
 * query rather than fifty. Grouping here rather than in the repository keeps the rule and its
 * batching in the same file: a second implementation of "newest user verdict wins" written for
 * speed is exactly how a list and a detail view start showing different colours.
 */
export function resolveClassifications<T extends ResolvableClassification & { foodId: string }>(
  candidates: readonly T[],
  userId: string,
): Map<string, T> {
  const byFood = new Map<string, T[]>();
  for (const row of candidates) {
    const bucket = byFood.get(row.foodId);
    if (bucket === undefined) {
      byFood.set(row.foodId, [row]);
    } else {
      bucket.push(row);
    }
  }

  const resolved = new Map<string, T>();
  for (const [foodId, rows] of byFood) {
    const winner = resolveClassification(rows, userId);
    if (winner !== undefined) {
      resolved.set(foodId, winner);
    }
  }

  return resolved;
}
