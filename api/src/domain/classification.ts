import type { Category, ClassificationSource } from '@portionium/schemas';

export interface ResolvableClassification {
  id: string;
  userId: string | null;
  category: Category;
  source: ClassificationSource;
  createdAt: Date;
}

const MODEL_SOURCES: ReadonlySet<ClassificationSource> = new Set(['ai_text', 'ai_vision']);

/** Newest first, tie-broken by id: a seed run writes hundreds of rows in the same millisecond. */
function newest<T extends ResolvableClassification>(rows: readonly T[]): T | undefined {
  return rows.reduce<T | undefined>((best, row) => {
    if (best === undefined) {
      return row;
    }

    const byTime = row.createdAt.getTime() - best.createdAt.getTime();
    return byTime > 0 || (byTime === 0 && row.id > best.id) ? row : best;
  }, undefined);
}

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
