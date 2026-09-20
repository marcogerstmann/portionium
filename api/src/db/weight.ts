import { and, desc, eq, gte, isNull, lt, lte } from 'drizzle-orm';

import type { NewWeightEntry } from '../domain/weight.js';
import type { Db } from './client.js';
import { weightEntryTable } from './schema/index.js';

export type WeightEntryRecord = typeof weightEntryTable.$inferSelect;

export interface WeightListFilters {
  userId: string;
  limit: number;
  cursor?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

export function insertWeightEntry(db: Db, entry: NewWeightEntry): WeightEntryRecord {
  return db.insert(weightEntryTable).values(entry).returning().get();
}

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

export function listWeightHistoryForUser(db: Db, userId: string): WeightEntryRecord[] {
  return db
    .select()
    .from(weightEntryTable)
    .where(and(eq(weightEntryTable.userId, userId), isNull(weightEntryTable.deletedAt)))
    .all();
}

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
