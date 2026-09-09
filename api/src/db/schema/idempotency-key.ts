import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import { baseColumns } from './base.js';
import { userTable } from './user.js';

/**
 * One row per `Idempotency-Key` a user has sent, holding the answer their first request got.
 *
 * The row is written in two steps. It is inserted, with no response, the moment a keyed
 * request is about to run, and the unique index on (user, key) is what stops a second copy of
 * that request from running too: the second insert does nothing, which the plugin reads as
 * "somebody else has this". No lock, no mutex, no table of in flight requests. The response is
 * filled in once the handler has answered, see http/plugins/idempotency.ts.
 *
 * Keys are scoped by user rather than global because a key is chosen by a client, and two
 * clients choosing "1" on the same day is not a collision anybody should have to think about.
 *
 * Rows are deleted by a scheduled purge after IDEMPOTENCY_RETENTION_HOURS rather than soft
 * deleted, for the same reason sessions are: a key past its window is not history worth
 * keeping, and `deleted_at` stays null here. Why the body is stored and why the window is a
 * day is docs/adr/004-idempotency-keys.md.
 */
export const idempotencyKeyTable = sqliteTable(
  'idempotency_key',
  {
    ...baseColumns,
    userId: text('user_id')
      .notNull()
      .references(() => userTable.id),
    /** The client's string, as sent. Opaque to the server. */
    key: text('key').notNull(),
    /** SHA-256 of method, URL and canonical body, see domain/idempotency.ts. */
    fingerprint: text('fingerprint').notNull(),
    /** Null until the first request has answered, which is how an in flight one is recognised. */
    responseStatus: integer('response_status'),
    /** The serialised body exactly as it was sent, or null for a response that had none. */
    responseBody: text('response_body'),
    responseContentType: text('response_content_type'),
  },
  (table) => [uniqueIndex('idempotency_key_user_key_unique').on(table.userId, table.key)],
);
