import { and, eq, lt } from 'drizzle-orm';

import type { Db } from './client.js';
import { idempotencyKeyTable } from './schema/index.js';

export type IdempotencyKeyRecord = typeof idempotencyKeyTable.$inferSelect;

export interface StoredResponse {
  status: number;
  body: string | null;
  contentType: string | null;
}

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

export function releaseIdempotencyKey(db: Db, id: string): void {
  db.delete(idempotencyKeyTable).where(eq(idempotencyKeyTable.id, id)).run();
}

export function purgeIdempotencyKeys(db: Db, createdBefore: Date): number {
  return db
    .delete(idempotencyKeyTable)
    .where(lt(idempotencyKeyTable.createdAt, createdBefore))
    .run().changes;
}
