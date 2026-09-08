import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { baseColumns } from './base.js';
import { userTable } from './user.js';

/**
 * A signed in browser. One row per login, and the thing a password change destroys.
 *
 * `token_hash` is a SHA-256 of the token the client holds, never the token itself. The token is
 * 256 bits from a CSPRNG rather than something derived, so there is nothing to brute force in
 * the hash and a plain digest is the right primitive here, unlike a password. What this buys is
 * that a copy of this file is not a set of live sessions.
 *
 * `id` is the row's identity and is safe to show: it is what a later story lists sessions by and
 * revokes them by, which is exactly why it is not the credential.
 *
 * Sessions are deleted rather than soft deleted. `deleted_at` arrives with baseColumns and stays
 * null here. An expired or revoked credential is not history worth keeping, and a table of dead
 * sessions is a table every lookup has to remember to filter.
 */
export const sessionTable = sqliteTable(
  'session',
  {
    ...baseColumns,
    userId: text('user_id')
      .notNull()
      .references(() => userTable.id),
    tokenHash: text('token_hash').notNull().unique(),
    /** Absolute, in UTC. The sliding refresh that moves it belongs to the sessions story. */
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  },
  // Both reads this table gets are by owner: invalidating a user's sessions, and listing them.
  (table) => [index('session_user_idx').on(table.userId)],
);
