import { emailSchema } from '@portionium/schemas';
import { and, count, eq, gt, isNull } from 'drizzle-orm';

import type { Db } from './client.js';
import { sessionTable, userTable } from './schema/index.js';

/**
 * Every query the sign in path makes. Accounts and sessions are one file because they are one
 * story: the only reason a session row exists is a user row, and the only interesting write in
 * here changes both at once.
 *
 * Email normalisation happens here rather than at each caller. This is the funnel every read
 * and every write goes through, so the column can only ever hold one spelling of an address,
 * which is what makes its unique index case insensitive without a collation.
 */

export type UserRecord = typeof userTable.$inferSelect;
export type SessionRecord = typeof sessionTable.$inferSelect;

export interface NewUser {
  email: string;
  passwordHash: string;
  displayName: string;
  role?: UserRecord['role'];
  timezone: string;
  dayBoundaryHour?: number;
}

/**
 * Throws on an address that is not one. Every caller has already validated, by the request
 * schema or by the CLI, so reaching this with junk means a path skipped its boundary and a
 * loud failure is the right one.
 */
function normalizeEmail(email: string): string {
  return emailSchema.parse(email);
}

/**
 * Live accounts only. A soft deleted user is not a user who can sign in, and leaving that to
 * the caller is how one endpoint eventually forgets.
 */
export function findUserByEmail(db: Db, email: string): UserRecord | undefined {
  return db
    .select()
    .from(userTable)
    .where(and(eq(userTable.email, normalizeEmail(email)), isNull(userTable.deletedAt)))
    .get();
}

export function insertUser(db: Db, user: NewUser): UserRecord {
  return db
    .insert(userTable)
    .values({ ...user, email: normalizeEmail(user.email) })
    .returning()
    .get();
}

/** Whether this instance has any account at all, which is what makes the first one an admin. */
export function countUsers(db: Db): number {
  return (
    db.select({ value: count() }).from(userTable).where(isNull(userTable.deletedAt)).get()?.value ??
    0
  );
}

/**
 * The one read on the authenticated request path: a session token hash in, the account it
 * belongs to out. Joined rather than fetched in two steps, because a session is worthless
 * without its user and every caller wants both.
 *
 * Three conditions, and leaving any of them to the caller is how one adapter eventually forgets
 * one: the hash has to match, the session has to be live, and the account has to be live. An
 * expired row and a deleted owner are both "not signed in", answered here rather than argued
 * about upstream.
 *
 * `now` is a parameter so a test can look at a session from either side of its expiry without
 * moving the clock.
 *
 * ponytail: expired rows are filtered, never deleted. They accumulate at one row per login and
 * SQLite does not care. Sweep them on a schedule if a busy instance ever makes that untrue,
 * which is the sessions story that also adds logout.
 */
export function findSessionUser(
  db: Db,
  tokenHash: string,
  now: Date = new Date(),
): UserRecord | undefined {
  return db
    .select({ user: userTable })
    .from(sessionTable)
    .innerJoin(userTable, eq(userTable.id, sessionTable.userId))
    .where(
      and(
        eq(sessionTable.tokenHash, tokenHash),
        gt(sessionTable.expiresAt, now),
        isNull(userTable.deletedAt),
      ),
    )
    .get()?.user;
}

export function insertSession(
  db: Db,
  session: { userId: string; tokenHash: string; expiresAt: Date },
): SessionRecord {
  return db.insert(sessionTable).values(session).returning().get();
}

/**
 * Sets a new password and ends every session that was opened with the old one, in one
 * transaction, because a password that has been changed while a session it authorised is still
 * live is a password that has not really been changed.
 *
 * API tokens are deliberately untouched. They are a separate credential a user issued on
 * purpose, to a script that is not sitting at the keyboard, and revoking them because somebody
 * rotated their password would break automation as a side effect of good hygiene. They are
 * revoked one at a time, by their owner, which is the sessions and API tokens story. There is
 * no api_tokens table yet, so today this is a promise rather than a filter, and the test beside
 * it is what will notice if a later story makes it one.
 *
 * Returns the number of sessions that were invalidated.
 */
export function setPasswordHash(db: Db, userId: string, passwordHash: string): number {
  return db.transaction((tx) => {
    tx.update(userTable)
      .set({ passwordHash })
      .where(and(eq(userTable.id, userId), isNull(userTable.deletedAt)))
      .run();

    return tx.delete(sessionTable).where(eq(sessionTable.userId, userId)).run().changes;
  });
}
