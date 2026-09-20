import { integer, text } from 'drizzle-orm/sqlite-core';
import { uuidv7 } from 'uuidv7';

export const baseColumns = {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => uuidv7()),

  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),

  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date()),

  deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
};
