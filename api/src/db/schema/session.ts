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
 * sessions is a table every lookup has to remember to filter. An API token is the opposite case
 * and is kept when revoked, see api-token.ts, because a token has a name and a history and a
 * session has neither.
 */
export const sessionTable = sqliteTable(
  'session',
  {
    ...baseColumns,
    userId: text('user_id')
      .notNull()
      .references(() => userTable.id),
    tokenHash: text('token_hash').notNull().unique(),
    /**
     * Absolute, in UTC, and moved forward as the session is used, see touchSession in db/auth.ts.
     * A person who uses this app every day is never signed out, and one who stops using it is
     * signed out thirty days later without anybody having to decide.
     */
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    /**
     * When a request last moved that expiry, which is what a user is shown when deciding whether
     * a listed session is one of theirs or one to revoke.
     *
     * Not derivable from `expires_at` minus the TTL, because the TTL is configurable and the
     * arithmetic would silently change meaning the day somebody edits it. Written by the same
     * throttled update that slides the expiry, so it costs no extra write.
     */
    lastActivityAt: integer('last_activity_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  // Both reads this table gets are by owner: invalidating a user's sessions, and listing them.
  (table) => [index('session_user_idx').on(table.userId)],
);
