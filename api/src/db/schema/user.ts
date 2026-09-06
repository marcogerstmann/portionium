import { USER_ROLES } from '@portionium/schemas';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { baseColumns } from './base.js';

/**
 * The account. `timezone` is not a display preference, it is what every local date on this
 * user's rows is derived from, so it is not nullable and it is not defaulted.
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
});
