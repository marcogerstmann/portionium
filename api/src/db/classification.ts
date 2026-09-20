import type { Category, ClassificationSource } from '@portionium/schemas';
import { and, desc, eq, exists, gte, inArray, isNull, not, notExists, or, sql } from 'drizzle-orm';

import type { Db } from './client.js';
import {
  entryTable,
  foodClassificationTable,
  foodClassificationWithdrawalTable,
  mealTable,
} from './schema/index.js';

export type FoodClassificationRecord = typeof foodClassificationTable.$inferSelect;

export interface NewClassification {
  foodId: string;
  category: Category;
  source: ClassificationSource;
  userId?: string | null;
  model?: string | null;
  promptVersion?: string | null;
  confidence?: number | null;
  reasoning?: string | null;
  assumptions?: string[] | null;
}

export function visibleTo(userId: string) {
  return or(isNull(foodClassificationTable.userId), eq(foodClassificationTable.userId, userId));
}

function withdrawnSince(db: Db, userId: string) {
  return db
    .select({ present: sql`1` })
    .from(foodClassificationWithdrawalTable)
    .where(
      and(
        eq(foodClassificationWithdrawalTable.foodId, foodClassificationTable.foodId),
        eq(foodClassificationWithdrawalTable.userId, userId),
        gte(foodClassificationWithdrawalTable.createdAt, foodClassificationTable.createdAt),
      ),
    );
}

export function insertClassifications(
  db: Omit<Db, '$client'>,
  verdicts: readonly NewClassification[],
): FoodClassificationRecord[] {
  if (verdicts.length === 0) {
    return [];
  }

  return db.transaction((tx) => {
    const stored = tx
      .insert(foodClassificationTable)
      .values([...verdicts])
      .returning()
      .all();

    for (const verdict of stored) {
      if (verdict.source === 'user' && verdict.userId !== null) {
        colourWaitingEntries(tx, verdict.foodId, verdict.userId, verdict.category);
      }
    }

    return stored;
  });
}

/**
 * Runs inside insertClassifications so the three routes writing a user verdict cannot forget it.
 * See docs/adr/011-an-entry-is-a-colour.md.
 */
function colourWaitingEntries(
  db: Omit<Db, '$client'>,
  foodId: string,
  userId: string,
  category: Category,
): void {
  db.update(entryTable)
    .set({ category })
    .where(
      and(
        eq(entryTable.foodId, foodId),
        isNull(entryTable.category),
        exists(
          db
            .select({ present: sql`1` })
            .from(mealTable)
            .where(and(eq(mealTable.id, entryTable.mealId), eq(mealTable.userId, userId))),
        ),
      ),
    )
    .run();
}

export function findClassificationsForFoods(
  db: Db,
  foodIds: readonly string[],
  userId: string,
): FoodClassificationRecord[] {
  if (foodIds.length === 0) {
    return [];
  }

  return db
    .select()
    .from(foodClassificationTable)
    .where(
      and(
        inArray(foodClassificationTable.foodId, [...foodIds]),
        visibleTo(userId),
        or(not(eq(foodClassificationTable.source, 'user')), notExists(withdrawnSince(db, userId))),
      ),
    )
    .all();
}

export function findClassificationHistory(
  db: Db,
  foodId: string,
  userId: string,
): FoodClassificationRecord[] {
  return db
    .select()
    .from(foodClassificationTable)
    .where(and(eq(foodClassificationTable.foodId, foodId), visibleTo(userId)))
    .orderBy(desc(foodClassificationTable.createdAt), desc(foodClassificationTable.id))
    .all();
}
