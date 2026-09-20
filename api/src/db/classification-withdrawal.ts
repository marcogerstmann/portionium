import type { Db } from './client.js';
import { foodClassificationWithdrawalTable } from './schema/index.js';

export function withdrawClassification(db: Db, foodId: string, userId: string): void {
  db.insert(foodClassificationWithdrawalTable).values({ foodId, userId }).run();
}
