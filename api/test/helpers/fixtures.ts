import type { EntryInput, Scope } from '@portionium/schemas';

import { findClassificationsForFoods } from '../../src/db/classification.js';
import type { Db } from '../../src/db/client.js';
import {
  apiTokenTable,
  foodClassificationTable,
  foodTable,
  entryTable,
  mealTable,
  sessionTable,
  userTable,
  weightEntryTable,
} from '../../src/db/schema/index.js';
import { createApiToken, createSessionToken } from '../../src/domain/auth.js';
import { resolveClassifications } from '../../src/domain/classification.js';
import { resolveLocalDate } from '../../src/domain/local-date.js';
import { createMeal } from '../../src/domain/meal.js';
import { createTestDatabase, type TestDatabase } from './database.js';

export type UserRow = typeof userTable.$inferSelect;
export type FoodRow = typeof foodTable.$inferSelect;
export type FoodClassificationRow = typeof foodClassificationTable.$inferSelect;
export type MealRow = typeof mealTable.$inferSelect;
export type EntryRow = typeof entryTable.$inferSelect;
export type WeightEntryRow = typeof weightEntryTable.$inferSelect;
export type SessionRow = typeof sessionTable.$inferSelect;
export type ApiTokenRow = typeof apiTokenTable.$inferSelect;

export const TEST_PASSWORD = 'correct horse battery staple';

export const TEST_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$BqG+n7Zh5aZxPFY9azspqg$oci1GxAoLH1EH/1nHU30HXC4VdsF4qScvsft09ChiXc';

let sequence = 0;

export interface MealOverrides {
  type?: MealRow['type'];
  loggedAt?: Date;
  notes?: string;
  entries?: readonly EntryInput[];
}

export interface SessionOverrides {
  expiresAt?: Date;
  lastActivityAt?: Date;
}

export interface ApiTokenOverrides {
  name?: string;
  scopes?: Scope[];
  expiresAt?: Date | null;
  revokedAt?: Date | null;
  lastUsedAt?: Date | null;
}

export interface Factories {
  user(overrides?: Partial<typeof userTable.$inferInsert>): UserRow;
  session(owner: UserRow, overrides?: SessionOverrides): string;
  apiToken(owner: UserRow, overrides?: ApiTokenOverrides): string;
  food(overrides?: Partial<typeof foodTable.$inferInsert>): FoodRow;
  classification(
    food: FoodRow,
    overrides?: Partial<typeof foodClassificationTable.$inferInsert>,
  ): FoodClassificationRow;
  meal(user: UserRow, overrides?: MealOverrides): { meal: MealRow; entries: EntryRow[] };
  weightEntry(
    user: UserRow,
    overrides?: Partial<Pick<WeightEntryRow, 'weightGrams' | 'recordedAt'>>,
  ): WeightEntryRow;
}

export function createFactories(db: Db): Factories {
  function user(overrides: Partial<typeof userTable.$inferInsert> = {}): UserRow {
    const n = ++sequence;
    return db
      .insert(userTable)
      .values({
        email: `user-${n}@example.test`,
        passwordHash: TEST_PASSWORD_HASH,
        displayName: `User ${n}`,
        timezone: 'Europe/Berlin',
        ...overrides,
      })
      .returning()
      .get();
  }

  function session(owner: UserRow, overrides: SessionOverrides = {}): string {
    const { token, tokenHash, expiresAt } = createSessionToken();
    db.insert(sessionTable)
      .values({
        userId: owner.id,
        tokenHash,
        expiresAt: overrides.expiresAt ?? expiresAt,
        lastActivityAt: overrides.lastActivityAt ?? new Date(),
      })
      .run();

    return token;
  }

  function apiToken(owner: UserRow, overrides: ApiTokenOverrides = {}): string {
    const n = ++sequence;
    const { token, tokenHash } = createApiToken();
    db.insert(apiTokenTable)
      .values({
        userId: owner.id,
        name: overrides.name ?? `Token ${n}`,
        tokenHash,
        scopes: overrides.scopes ?? ['read', 'write'],
        expiresAt: overrides.expiresAt ?? null,
        revokedAt: overrides.revokedAt ?? null,
        lastUsedAt: overrides.lastUsedAt ?? null,
      })
      .run();

    return token;
  }

  function food(overrides: Partial<typeof foodTable.$inferInsert> = {}): FoodRow {
    const n = ++sequence;
    return db
      .insert(foodTable)
      .values({ name: `Food ${n}`, kind: 'ingredient', ...overrides })
      .returning()
      .get();
  }

  function classification(
    food: FoodRow,
    overrides: Partial<typeof foodClassificationTable.$inferInsert> = {},
  ): FoodClassificationRow {
    return db
      .insert(foodClassificationTable)
      .values({ foodId: food.id, category: 'green', source: 'seed', ...overrides })
      .returning()
      .get();
  }

  function meal(owner: UserRow, overrides: MealOverrides = {}) {
    const inputs = overrides.entries ?? [{ foodId: food().id }];

    const resolved = resolveClassifications(
      findClassificationsForFoods(
        db,
        inputs.flatMap((entry) => (entry.foodId === undefined ? [] : [entry.foodId])),
        owner.id,
      ),
      owner.id,
    );
    const entries = inputs.map((entry) => ({
      foodId: entry.foodId ?? null,
      category:
        entry.category ??
        (entry.foodId === undefined ? null : (resolved.get(entry.foodId)?.category ?? null)),
      ...(entry.quantity === undefined ? {} : { quantity: entry.quantity }),
    }));

    const validated = createMeal(
      {
        userId: owner.id,
        type: overrides.type ?? 'lunch',
        loggedAt: overrides.loggedAt ?? new Date(),
        ...(overrides.notes === undefined ? {} : { notes: overrides.notes }),
        entries,
      },
      owner,
    );

    const stored = db.insert(mealTable).values(validated.meal).returning().get();
    const storedEntries = db
      .insert(entryTable)
      .values(validated.entries.map((entry) => ({ ...entry, mealId: stored.id })))
      .returning()
      .all();

    return { meal: stored, entries: storedEntries };
  }

  function weightEntry(
    owner: UserRow,
    overrides: Partial<Pick<WeightEntryRow, 'weightGrams' | 'recordedAt'>> = {},
  ): WeightEntryRow {
    const recordedAt = overrides.recordedAt ?? new Date();
    return db
      .insert(weightEntryTable)
      .values({
        userId: owner.id,
        weightGrams: overrides.weightGrams ?? 82_000,
        recordedAt,
        localDate: resolveLocalDate(recordedAt, owner.timezone, owner.dayBoundaryHour),
      })
      .returning()
      .get();
  }

  return { user, session, apiToken, food, classification, meal, weightEntry };
}

export interface TestFixtures extends TestDatabase {
  create: Factories;
  userA: UserRow;
  userB: UserRow;
}

export function createTestFixtures(): TestFixtures {
  const database = createTestDatabase();
  const create = createFactories(database.db);

  return {
    ...database,
    create,
    userA: create.user({ displayName: 'User A', timezone: 'Europe/Berlin' }),
    userB: create.user({ displayName: 'User B', timezone: 'America/New_York' }),
  };
}
