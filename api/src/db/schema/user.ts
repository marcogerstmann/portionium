import { DEFAULT_DAY_BOUNDARY_HOUR, USER_ROLES } from '@portionium/schemas';
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
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  role: text('role', { enum: USER_ROLES }).notNull().default('user'),
  timezone: text('timezone').notNull(),
  dayBoundaryHour: integer('day_boundary_hour').notNull().default(DEFAULT_DAY_BOUNDARY_HOUR),
});
