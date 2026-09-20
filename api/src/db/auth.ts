import {
  emailSchema,
  type Locale,
  type Scope,
  type UpdateBudgetsRequest,
  type WeeklyBudgets,
} from '@portionium/schemas';
import { and, count, desc, eq, gt, isNull, or } from 'drizzle-orm';

import type { Db } from './client.js';
import { apiTokenTable, sessionTable, userTable } from './schema/index.js';

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

function normalizeEmail(email: string): string {
  return emailSchema.parse(email);
}

export function findUserByEmail(db: Db, email: string): UserRecord | undefined {
  return db
    .select()
    .from(userTable)
    .where(and(eq(userTable.email, normalizeEmail(email)), isNull(userTable.deletedAt)))
    .get();
}

export function findUserById(db: Db, userId: string): UserRecord | undefined {
  return db
    .select()
    .from(userTable)
    .where(and(eq(userTable.id, userId), isNull(userTable.deletedAt)))
    .get();
}

export interface ProfileChanges {
  displayName?: string | undefined;
  timezone?: string | undefined;
  dayBoundaryHour?: number | undefined;
  locale?: Locale | null | undefined;
  weeklyBudgetGreen?: number | null | undefined;
  weeklyBudgetYellow?: number | null | undefined;
  weeklyBudgetOrange?: number | null | undefined;
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

export function weeklyBudgetsOf(user: UserRecord): WeeklyBudgets {
  return {
    green: user.weeklyBudgetGreen,
    yellow: user.weeklyBudgetYellow,
    orange: user.weeklyBudgetOrange,
  };
}

export function updateWeeklyBudgets(
  db: Db,
  userId: string,
  budgets: UpdateBudgetsRequest,
): UserRecord | undefined {
  const changes: ProfileChanges = {};
  if (budgets.green !== undefined) {
    changes.weeklyBudgetGreen = budgets.green;
  }
  if (budgets.yellow !== undefined) {
    changes.weeklyBudgetYellow = budgets.yellow;
  }
  if (budgets.orange !== undefined) {
    changes.weeklyBudgetOrange = budgets.orange;
  }

  return updateUserProfile(db, userId, changes);
}

export function insertUser(db: Db, user: NewUser): UserRecord {
  return db
    .insert(userTable)
    .values({ ...user, email: normalizeEmail(user.email) })
    .returning()
    .get();
}

export function countUsers(db: Db): number {
  return (
    db.select({ value: count() }).from(userTable).where(isNull(userTable.deletedAt)).get()?.value ??
    0
  );
}

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
  // lastActivityAt comes from its column default, the same instant this would have written.
  return db.insert(sessionTable).values(session).returning().get();
}

export function touchSession(db: Db, sessionId: string, now: Date, ttlMs: number): void {
  db.update(sessionTable)
    .set({ lastActivityAt: now, expiresAt: new Date(now.getTime() + ttlMs) })
    .where(eq(sessionTable.id, sessionId))
    .run();
}

export function listSessions(db: Db, userId: string, now: Date = new Date()): SessionRecord[] {
  return db
    .select()
    .from(sessionTable)
    .where(and(eq(sessionTable.userId, userId), gt(sessionTable.expiresAt, now)))
    .orderBy(desc(sessionTable.createdAt))
    .all();
}

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

export function touchApiToken(db: Db, tokenId: string, now: Date): void {
  db.update(apiTokenTable).set({ lastUsedAt: now }).where(eq(apiTokenTable.id, tokenId)).run();
}

export function listApiTokens(db: Db, userId: string): ApiTokenRecord[] {
  return db
    .select()
    .from(apiTokenTable)
    .where(eq(apiTokenTable.userId, userId))
    .orderBy(desc(apiTokenTable.createdAt))
    .all();
}

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

export function revokeAllApiTokens(db: Db, userId: string, now: Date = new Date()): number {
  return db
    .update(apiTokenTable)
    .set({ revokedAt: now })
    .where(and(eq(apiTokenTable.userId, userId), isNull(apiTokenTable.revokedAt)))
    .run().changes;
}

export function setPasswordHash(db: Db, userId: string, passwordHash: string): number {
  return db.transaction((tx) => {
    tx.update(userTable)
      .set({ passwordHash })
      .where(and(eq(userTable.id, userId), isNull(userTable.deletedAt)))
      .run();

    return tx.delete(sessionTable).where(eq(sessionTable.userId, userId)).run().changes;
  });
}
