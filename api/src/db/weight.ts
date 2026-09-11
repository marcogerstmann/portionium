import { and, desc, eq, isNull } from 'drizzle-orm';

import type { Db } from './client.js';
import { weightEntryTable } from './schema/index.js';

/**
 * The one read GET /days/{date} needs. There is no write path here yet, logging a weight is a
 * later ticket, but the table and the domain plausibility check in domain/weight.ts already
 * exist, and a day view is meaningless without being able to show a reading if one is there.
 */

export type WeightEntryRecord = typeof weightEntryTable.$inferSelect;

/**
 * The reading that stands for one local day. People re-weigh, so more than one entry can share
 * a date, see the schema; the most recently recorded one is what a summary shows.
 */
export function findLatestWeightEntryForDay(
  db: Db,
  userId: string,
  localDate: string,
): WeightEntryRecord | undefined {
  return db
    .select()
    .from(weightEntryTable)
    .where(
      and(
        eq(weightEntryTable.userId, userId),
        eq(weightEntryTable.localDate, localDate),
        isNull(weightEntryTable.deletedAt),
      ),
    )
    .orderBy(desc(weightEntryTable.recordedAt))
    .get();
}
