import { and, desc, eq, gte, isNull, lt, lte } from 'drizzle-orm';

import type { NewWeightEntry } from '../domain/weight.js';
import type { Db } from './client.js';
import { weightEntryTable } from './schema/index.js';

/**
 * Every query a weight reading needs. Reads are always scoped to `userId`, the way every user
 * owned table in this codebase is, and never look at another account's rows.
 */

export type WeightEntryRecord = typeof weightEntryTable.$inferSelect;

export interface WeightListFilters {
  userId: string;
  limit: number;
  cursor?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

/**
 * Stores a reading. There is no unique constraint on (user_id, local_date), see the comment on
 * the table: people weigh themselves twice in a day and both readings are real. A caller reading
 * "the" weight for a day, GET /days/{date} and the history a plausibility check judges against
 * alike, gets the most recently recorded one, see findLatestWeightEntryForDay below.
 */
export function insertWeightEntry(db: Db, entry: NewWeightEntry): WeightEntryRecord {
  return db.insert(weightEntryTable).values(entry).returning().get();
}

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

/**
 * Every live reading a user has, for the plausibility check in domain/weight.ts to judge a new
 * one against. Unbounded: a personal weight log is at most a few thousand rows over years, and
 * the check itself is an O(n) scan over whatever this returns, see the comment beside it for
 * when that stops being true.
 */
export function listWeightHistoryForUser(db: Db, userId: string): WeightEntryRecord[] {
  return db
    .select()
    .from(weightEntryTable)
    .where(and(eq(weightEntryTable.userId, userId), isNull(weightEntryTable.deletedAt)))
    .all();
}

/**
 * A page of a caller's own readings, newest first, the same feed convention listMeals follows:
 * the cursor means "older than this" and the id comparison runs that way.
 */
export function listWeightEntries(db: Db, filters: WeightListFilters): WeightEntryRecord[] {
  const conditions = [
    eq(weightEntryTable.userId, filters.userId),
    isNull(weightEntryTable.deletedAt),
  ];

  if (filters.cursor !== undefined) {
    conditions.push(lt(weightEntryTable.id, filters.cursor));
  }
  if (filters.from !== undefined) {
    conditions.push(gte(weightEntryTable.localDate, filters.from));
  }
  if (filters.to !== undefined) {
    conditions.push(lte(weightEntryTable.localDate, filters.to));
  }

  return db
    .select()
    .from(weightEntryTable)
    .where(and(...conditions))
    .orderBy(desc(weightEntryTable.id))
    .limit(filters.limit)
    .all();
}

/** False when there was nothing live to delete, so deleting twice is a 404 rather than a 204. */
export function softDeleteWeightEntry(db: Db, userId: string, id: string): boolean {
  return (
    db
      .update(weightEntryTable)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(weightEntryTable.id, id),
          eq(weightEntryTable.userId, userId),
          isNull(weightEntryTable.deletedAt),
        ),
      )
      .returning({ id: weightEntryTable.id })
      .get() !== undefined
  );
}
