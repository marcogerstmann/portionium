import { DEFAULT_DAY_BOUNDARY_HOUR, LOCALES, USER_ROLES } from '@portionium/schemas';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { baseColumns } from './base.js';

export const userTable = sqliteTable('user', {
  ...baseColumns,
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name').notNull(),
  role: text('role', { enum: USER_ROLES }).notNull().default('user'),
  timezone: text('timezone').notNull(),
  dayBoundaryHour: integer('day_boundary_hour').notNull().default(DEFAULT_DAY_BOUNDARY_HOUR),
  locale: text('locale', { enum: LOCALES }),
  weeklyBudgetGreen: integer('weekly_budget_green'),
  weeklyBudgetYellow: integer('weekly_budget_yellow'),
  weeklyBudgetOrange: integer('weekly_budget_orange'),
});
