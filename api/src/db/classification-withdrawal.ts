import type { Db } from './client.js';
import { foodClassificationWithdrawalTable } from './schema/index.js';

/**
 * Records that this user no longer stands behind their own verdict on this food, so the next
 * read falls back to the AI or seed one. See findClassificationsForFoods, which is where that
 * fallback actually happens.
 *
 * Always inserts, even if this food was never overridden or is already withdrawn: it costs
 * nothing to be wrong about that, and checking first is a query this endpoint does not need to
 * make. The table is tiny for the same reason the classification log is, see
 * docs/adr/007-append-only-classification-log.md.
 */
export function withdrawClassification(db: Db, foodId: string, userId: string): void {
  db.insert(foodClassificationWithdrawalTable).values({ foodId, userId }).run();
}
