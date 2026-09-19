import { DEFAULT_DAY_BOUNDARY_HOUR, LOCALES, USER_ROLES } from '@portionium/schemas';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { baseColumns } from './base.js';

/**
 * The account. `timezone` is not a display preference, it is what every local date on this
 * user's rows is derived from, so it is not nullable and it is not defaulted.
 *
 * `day_boundary_hour` is the other half of that derivation and does have a default, because
 * four in the morning suits almost everybody and asking at signup would not improve it. The two
 * are read together by resolveLocalDate in domain/local-date.ts and never separately.
 *
 * The enum comes from the shared schema so the union has one definition. SQLite has no enum
 * type, this is a TypeScript level narrowing over a text column and costs nothing in the file.
 */
export const userTable = sqliteTable('user', {
  ...baseColumns,
  /**
   * Stored lowercased and trimmed. The unique index below is therefore case insensitive in
   * effect without a collation, because there is only ever one spelling of an address in this
   * column: every write goes through the repository in db/auth.ts, which normalises with
   * emailSchema before it touches the table, and every read normalises the same way.
   */
  email: text('email').notNull().unique(),
  /**
   * Argon2id, in the PHC string format that carries its own parameters, so a hash produced
   * under today's cost settings stays verifiable after they are raised. Never leaves db/ and
   * deliberately has no field on userSchema, so there is no response shape it can appear in.
   */
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name').notNull(),
  role: text('role', { enum: USER_ROLES }).notNull().default('user'),
  timezone: text('timezone').notNull(),
  dayBoundaryHour: integer('day_boundary_hour').notNull().default(DEFAULT_DAY_BOUNDARY_HOUR),
  /**
   * The chosen interface language. Nullable with no default: null is what a fresh account has
   * and means "never chosen", which is what lets the client keep following the browser rather
   * than pinning it to whatever `navigator.languages` said at signup, see resolveLocale in
   * web/src/i18n.ts.
   */
  locale: text('locale', { enum: LOCALES }),
  /**
   * The weekly allowance per category, or null for unlimited, which is the default for
   * all three so an untouched account behaves exactly as it did before this existed.
   *
   * Three columns on the account rather than a `weekly_budgets` table. A table would buy a row
   * per category and cost a repository, an upsert and a join on the two hot read paths that
   * want these, GET /days/{date} and GET /stats/budget, both of which already have this row in
   * hand. There are exactly three categories and CATEGORIES is a closed union, so the thing a
   * table would make cheap, adding a fourth, is a migration either way.
   *
   * Nullable with no default, and zero is a different value: null is "no intention recorded",
   * zero is "none of this colour this week". See weeklyBudgetLimitSchema.
   */
  weeklyBudgetGreen: integer('weekly_budget_green'),
  weeklyBudgetYellow: integer('weekly_budget_yellow'),
  weeklyBudgetOrange: integer('weekly_budget_orange'),
});
