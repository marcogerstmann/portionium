import type { Scope } from '@portionium/schemas';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { baseColumns } from './base.js';
import { userTable } from './user.js';

/**
 * A credential a user issued on purpose, to something that is not sitting at a keyboard: the
 * MCP server, a script, whatever automates against this instance later.
 *
 * It is a separate table from `session` rather than a flag on it, because the two are different
 * credentials with different lifetimes and different rules. A session is minted by typing a
 * password, expires by sliding, and dies when the password changes. A token is minted from a
 * session, carries a subset of its owner's scopes, may outlive every session, and survives a
 * password rotation deliberately: revoking a colleague's automation because somebody practised
 * good hygiene is a side effect nobody asked for. See setPasswordHash in db/auth.ts.
 *
 * `token_hash` is a SHA-256 of the string the holder has, never the string itself, for the same
 * reason as on `session`: a copy of this file is not a set of working credentials. The plaintext
 * exists in exactly one HTTP response and is unrecoverable afterwards.
 */
export const apiTokenTable = sqliteTable(
  'api_token',
  {
    ...baseColumns,
    userId: text('user_id')
      .notNull()
      .references(() => userTable.id),
    /** What this token is for, in the owner's words. The only reason a list of them is useful. */
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    /**
     * The scopes granted, as JSON. An array in a text column rather than a join table: this is
     * read on every authenticated request, it is never queried across rows, and three values
     * from a closed union do not need referential integrity to stay honest.
     *
     * Stored exactly as granted rather than expanded. `write` implies `read` at check time, see
     * expandScopes, and writing the expansion into the row would freeze today's implication
     * into data that outlives it.
     */
    scopes: text('scopes', { mode: 'json' }).notNull().$type<Scope[]>(),
    /**
     * Last request this token authenticated, written at most once a minute so that a busy
     * script does not turn every read into a write. Null until it is first used, which is a
     * fact worth showing: a token nobody ever used is a token somebody can revoke without asking.
     */
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
    /** Null means it lives until revoked. A date means it stops working on its own. */
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    /**
     * Set when the owner revokes it. Unlike a session, which is deleted outright, a revoked
     * token is kept: its name and last use are the record of what a credential that has been
     * turned off was doing, which is the first thing anybody wants after turning one off.
     */
    revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
  },
  // Both reads are by owner: listing a user's tokens, and revoking one of them by id.
  (table) => [index('api_token_user_idx').on(table.userId)],
);
