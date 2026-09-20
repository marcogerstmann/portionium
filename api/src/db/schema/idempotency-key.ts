import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import { baseColumns } from './base.js';
import { userTable } from './user.js';

export const idempotencyKeyTable = sqliteTable(
  'idempotency_key',
  {
    ...baseColumns,
    userId: text('user_id')
      .notNull()
      .references(() => userTable.id),
    key: text('key').notNull(),
    fingerprint: text('fingerprint').notNull(),
    responseStatus: integer('response_status'),
    responseBody: text('response_body'),
    responseContentType: text('response_content_type'),
  },
  (table) => [uniqueIndex('idempotency_key_user_key_unique').on(table.userId, table.key)],
);
