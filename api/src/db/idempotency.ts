import { and, eq, lt } from 'drizzle-orm';

import type { Db } from './client.js';
import { idempotencyKeyTable } from './schema/index.js';

/**
 * Every query behind an `Idempotency-Key`. Four of them, and the interesting one is the first:
 * it is the whole of the concurrency story, see the schema file.
 */

export type IdempotencyKeyRecord = typeof idempotencyKeyTable.$inferSelect;

export interface StoredResponse {
  status: number;
  body: string | null;
  contentType: string | null;
}

/**
 * Claims a key for this user, or reports that it is already claimed.
 *
 * `ON CONFLICT DO NOTHING` rather than catching the constraint error, because the insert doing
 * nothing is the expected path for a retry and an exception is the wrong shape for an expected
 * path. Returns the new row, or undefined when the unique index refused it, in which case the
 * caller reads the existing row with findIdempotencyKey. Two reads rather than one upsert,
 * because an upsert would overwrite the fingerprint this call exists to compare against.
 */
export function claimIdempotencyKey(
  db: Db,
  claim: { userId: string; key: string; fingerprint: string },
): IdempotencyKeyRecord | undefined {
  return db.insert(idempotencyKeyTable).values(claim).onConflictDoNothing().returning().get();
}

export function findIdempotencyKey(
  db: Db,
  userId: string,
  key: string,
): IdempotencyKeyRecord | undefined {
  return db
    .select()
    .from(idempotencyKeyTable)
    .where(and(eq(idempotencyKeyTable.userId, userId), eq(idempotencyKeyTable.key, key)))
    .get();
}

/** Fills in the answer, which is what turns a claimed key into a replayable one. */
export function storeIdempotencyResponse(db: Db, id: string, response: StoredResponse): void {
  db.update(idempotencyKeyTable)
    .set({
      responseStatus: response.status,
      responseBody: response.body,
      responseContentType: response.contentType,
    })
    .where(eq(idempotencyKeyTable.id, id))
    .run();
}

/**
 * Releases a claim whose request did not produce an answer worth keeping. A 500 is the case:
 * the operation may or may not have happened, and pinning that uncertainty to the key for a
 * day would make the retry, the one thing the key exists for, impossible.
 */
export function releaseIdempotencyKey(db: Db, id: string): void {
  db.delete(idempotencyKeyTable).where(eq(idempotencyKeyTable.id, id)).run();
}

/** The scheduled purge. Returns how many keys were dropped. */
export function purgeIdempotencyKeys(db: Db, createdBefore: Date): number {
  return db
    .delete(idempotencyKeyTable)
    .where(lt(idempotencyKeyTable.createdAt, createdBefore))
    .run().changes;
}
