import { emailSchema, type Scope } from '@portionium/schemas';
import { and, count, desc, eq, gt, isNull, or } from 'drizzle-orm';

import type { Db } from './client.js';
import { apiTokenTable, sessionTable, userTable } from './schema/index.js';

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
export type ApiTokenRecord = typeof apiTokenTable.$inferSelect;

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

/**
 * The same read by id, which is what an authenticated request has. `request.auth` carries the
 * id, the role and the scopes and deliberately nothing else, so anything that wants a profile
 * comes back here for the row rather than growing the context into a cache of it.
 */
export function findUserById(db: Db, userId: string): UserRecord | undefined {
  return db
    .select()
    .from(userTable)
    .where(and(eq(userTable.id, userId), isNull(userTable.deletedAt)))
    .get();
}

/**
 * The three fields a user owns about themselves. Email and role are not here: an address
 * identifies the account and a role is granted rather than chosen, so neither is something a
 * profile update can reach even if a caller sends one.
 *
 * Undefined means untouched. Drizzle drops undefined values from a set and then refuses one
 * with nothing left in it, so an empty patch is answered with the row as it stands rather than
 * with a thrown query.
 */
export interface ProfileChanges {
  displayName?: string | undefined;
  timezone?: string | undefined;
  dayBoundaryHour?: number | undefined;
}

export function updateUserProfile(
  db: Db,
  userId: string,
  changes: ProfileChanges,
): UserRecord | undefined {
  if (Object.values(changes).every((value) => value === undefined)) {
    return findUserById(db, userId);
  }

  return db
    .update(userTable)
    .set(changes)
    .where(and(eq(userTable.id, userId), isNull(userTable.deletedAt)))
    .returning()
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
 * The read on the authenticated request path for a browser: a session token hash in, the
 * session and the account it belongs to out. Joined rather than fetched in two steps, because
 * a session is worthless without its user and every caller wants both.
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
 * SQLite does not care, and a sliding expiry means an abandoned session disappears from a list
 * within a month anyway. Sweep them on a schedule if an instance ever logs in often enough for
 * that to be untrue.
 */
export function findSessionUser(
  db: Db,
  tokenHash: string,
  now: Date = new Date(),
): { user: UserRecord; session: SessionRecord } | undefined {
  return db
    .select({ user: userTable, session: sessionTable })
    .from(sessionTable)
    .innerJoin(userTable, eq(userTable.id, sessionTable.userId))
    .where(
      and(
        eq(sessionTable.tokenHash, tokenHash),
        gt(sessionTable.expiresAt, now),
        isNull(userTable.deletedAt),
      ),
    )
    .get();
}

export function insertSession(
  db: Db,
  session: { userId: string; tokenHash: string; expiresAt: Date },
): SessionRecord {
  // lastActivityAt comes from its column default, which is the same `new Date()` this would
  // have written. See the session schema.
  return db.insert(sessionTable).values(session).returning().get();
}

/**
 * The sliding expiry, applied. Both columns move together in one statement, because the point
 * of `last_activity_at` is to say when the expiry was last pushed out and two writes could
 * disagree about that.
 *
 * Called only when the activity record has gone stale, see shouldRecordActivity, so this is a
 * write roughly once a minute per active session rather than once per request.
 */
export function touchSession(db: Db, sessionId: string, now: Date, ttlMs: number): void {
  db.update(sessionTable)
    .set({ lastActivityAt: now, expiresAt: new Date(now.getTime() + ttlMs) })
    .where(eq(sessionTable.id, sessionId))
    .run();
}

/**
 * A user's live sessions, newest first. Expired rows are filtered rather than shown: a list of
 * signed in browsers that includes ones that are not signed in is a list nobody can act on.
 */
export function listSessions(db: Db, userId: string, now: Date = new Date()): SessionRecord[] {
  return db
    .select()
    .from(sessionTable)
    .where(and(eq(sessionTable.userId, userId), gt(sessionTable.expiresAt, now)))
    .orderBy(desc(sessionTable.createdAt))
    .all();
}

/**
 * Ends one session, if it is this user's. The owner is part of the where clause rather than
 * checked afterwards, so a session id belonging to somebody else deletes nothing and the
 * caller cannot tell it from an id that never existed. See ADR 003.
 *
 * Returns whether anything was deleted.
 */
export function deleteSession(db: Db, userId: string, sessionId: string): boolean {
  return (
    db
      .delete(sessionTable)
      .where(and(eq(sessionTable.id, sessionId), eq(sessionTable.userId, userId)))
      .run().changes > 0
  );
}

export interface NewApiToken {
  userId: string;
  name: string;
  tokenHash: string;
  scopes: Scope[];
  expiresAt: Date | null;
}

export function insertApiToken(db: Db, token: NewApiToken): ApiTokenRecord {
  return db.insert(apiTokenTable).values(token).returning().get();
}

/**
 * The read on the authenticated request path for a script. The counterpart to findSessionUser,
 * with one more way to be dead: a token can be revoked, which a session cannot, because
 * revoking a session is deleting it.
 *
 * A null `expires_at` means the token does not expire, so the expiry condition has to admit it.
 * Writing that as an `or` rather than a coalesce keeps the index usable and keeps the intent
 * readable: no expiry, or an expiry that has not arrived.
 */
export function findApiTokenUser(
  db: Db,
  tokenHash: string,
  now: Date = new Date(),
): { user: UserRecord; token: ApiTokenRecord } | undefined {
  return db
    .select({ user: userTable, token: apiTokenTable })
    .from(apiTokenTable)
    .innerJoin(userTable, eq(userTable.id, apiTokenTable.userId))
    .where(
      and(
        eq(apiTokenTable.tokenHash, tokenHash),
        isNull(apiTokenTable.revokedAt),
        or(isNull(apiTokenTable.expiresAt), gt(apiTokenTable.expiresAt, now)),
        isNull(userTable.deletedAt),
      ),
    )
    .get();
}

/** Throttled by shouldRecordActivity, so a script polling this API does not write per request. */
export function touchApiToken(db: Db, tokenId: string, now: Date): void {
  db.update(apiTokenTable).set({ lastUsedAt: now }).where(eq(apiTokenTable.id, tokenId)).run();
}

/**
 * A user's tokens, newest first, including the revoked ones. A revoked token's name and last
 * use are the record of what a credential somebody turned off had been doing, which is the
 * first thing anybody wants after turning one off.
 */
export function listApiTokens(db: Db, userId: string): ApiTokenRecord[] {
  return db
    .select()
    .from(apiTokenTable)
    .where(eq(apiTokenTable.userId, userId))
    .orderBy(desc(apiTokenTable.createdAt))
    .all();
}

/**
 * Stops a token working, now. The next request carrying it reads this row and does not find a
 * live one, because there is no cache in front of this and deliberately so: a revocation that
 * takes effect in a minute is a revocation somebody has to reason about during an incident.
 *
 * Already revoked returns false, so revoking twice is not reported as having done something.
 */
export function revokeApiToken(
  db: Db,
  userId: string,
  tokenId: string,
  now: Date = new Date(),
): boolean {
  return (
    db
      .update(apiTokenTable)
      .set({ revokedAt: now })
      .where(
        and(
          eq(apiTokenTable.id, tokenId),
          eq(apiTokenTable.userId, userId),
          isNull(apiTokenTable.revokedAt),
        ),
      )
      .run().changes > 0
  );
}

/**
 * Revokes every live token an account has, and answers how many that was.
 *
 * The incident version of revokeApiToken above. One at a time by their owner is right for
 * retiring a script; it is the wrong shape at the moment somebody believes a credential has
 * leaked and does not yet know which, because that is exactly when a list has to be worked
 * through under pressure. This is the command SECURITY.md points at, run from the machine the
 * database file is on, which is the same authorisation making the account needed.
 *
 * Already revoked rows are left as they are, so the count is tokens that were actually working
 * a moment ago rather than rows touched, and running it twice reports nothing the second time.
 */
export function revokeAllApiTokens(db: Db, userId: string, now: Date = new Date()): number {
  return db
    .update(apiTokenTable)
    .set({ revokedAt: now })
    .where(and(eq(apiTokenTable.userId, userId), isNull(apiTokenTable.revokedAt)))
    .run().changes;
}

/**
 * Sets a new password and ends every session that was opened with the old one, in one
 * transaction, because a password that has been changed while a session it authorised is still
 * live is a password that has not really been changed.
 *
 * API tokens are deliberately untouched. They are a separate credential a user issued on
 * purpose, to a script that is not sitting at the keyboard, and revoking them because somebody
 * rotated their password would break automation as a side effect of good hygiene. They are
 * revoked one at a time, by their owner, with revokeApiToken above. The table exists now, so
 * this is a filter that is deliberately absent rather than a promise, and the test beside it is
 * what notices if somebody adds one.
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
