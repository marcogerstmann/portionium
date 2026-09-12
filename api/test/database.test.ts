import { existsSync } from 'node:fs';

import { sql } from 'drizzle-orm';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { databaseNotReadyReason } from '../src/db/client.js';
import { baseColumns } from '../src/db/schema/base.js';
import { createTestDatabase, reopenTestDatabase, type TestDatabase } from './helpers/database.js';

/**
 * A table that exists only for this file. The real tables arrive with the domain model story,
 * but the base column helper and the pragmas need something to act on, and a throwaway table
 * keeps that check from going stale every time the real schema changes.
 */
const widget = sqliteTable('widget', { ...baseColumns, label: text('label') });

const CREATE_WIDGET = `
  create table widget (
    id text primary key,
    created_at integer not null,
    updated_at integer not null,
    deleted_at integer,
    label text
  )
`;

describe('openDatabase', () => {
  let database: TestDatabase;

  beforeEach(() => {
    database = createTestDatabase();
  });

  afterEach(() => {
    database.close();
  });

  describe('pragmas', () => {
    it('puts the journal in WAL mode', () => {
      expect(database.db.$client.pragma('journal_mode', { simple: true })).toBe('wal');
    });

    it('enforces foreign keys, which SQLite leaves off by default', () => {
      expect(database.db.$client.pragma('foreign_keys', { simple: true })).toBe(1);
    });

    it('waits on a busy writer for five seconds instead of failing immediately', () => {
      expect(database.db.$client.pragma('busy_timeout', { simple: true })).toBe(5000);
    });

    it('sets synchronous to NORMAL', () => {
      // 1 is NORMAL. 2 is FULL, the default outside WAL mode.
      expect(database.db.$client.pragma('synchronous', { simple: true })).toBe(1);
    });

    it('applies the per connection pragmas again on a second connection', () => {
      // Only journal_mode is stored in the file. If these were set once at setup time rather
      // than per connection, this is where it would show.
      const second = reopenTestDatabase(database);
      try {
        expect(second.db.$client.pragma('foreign_keys', { simple: true })).toBe(1);
        expect(second.db.$client.pragma('busy_timeout', { simple: true })).toBe(5000);
        expect(second.db.$client.pragma('synchronous', { simple: true })).toBe(1);
      } finally {
        second.close();
      }
    });
  });

  describe('migrations', () => {
    it('records what it has applied so a restart can skip it', () => {
      const applied = database.db.$client
        .prepare(`select count(*) as count from sqlite_master where name = '__drizzle_migrations'`)
        .get() as { count: number };

      expect(applied.count).toBe(1);
    });

    it('is idempotent, a second startup neither fails nor discards data', () => {
      database.db.$client.exec(CREATE_WIDGET);
      database.db.$client.exec(
        `insert into widget (id, created_at, updated_at) values ('a', 0, 0)`,
      );

      const restarted = reopenTestDatabase(database);
      try {
        const rows = restarted.db.$client.prepare('select id from widget').all();
        expect(rows).toEqual([{ id: 'a' }]);
      } finally {
        restarted.close();
      }
    });

    it('creates the database file and its parent directory', () => {
      expect(existsSync(database.path)).toBe(true);
    });
  });

  describe('foreign keys', () => {
    it('rejects a row that points at a parent which is not there', () => {
      database.db.$client.exec(CREATE_WIDGET);
      database.db.$client.exec(
        `create table widget_part (id text primary key, widget_id text not null references widget(id))`,
      );

      expect(() =>
        database.db.$client.exec(
          `insert into widget_part (id, widget_id) values ('p', 'does-not-exist')`,
        ),
      ).toThrow(/FOREIGN KEY/i);
    });
  });

  describe('base columns', () => {
    beforeEach(() => {
      database.db.$client.exec(CREATE_WIDGET);
    });

    it('fills in a UUIDv7 id, so ids sort by creation time', async () => {
      const [first] = await database.db.insert(widget).values({ label: 'first' }).returning();
      const [second] = await database.db.insert(widget).values({ label: 'second' }).returning();

      // Version nibble of a UUIDv7 sits at the start of the third group.
      expect(first?.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(second?.id).not.toBe(first?.id);
      expect(second!.id > first!.id).toBe(true);
    });

    it('stamps created_at and updated_at, and leaves deleted_at null', async () => {
      const before = Date.now();
      const [row] = await database.db.insert(widget).values({ label: 'a' }).returning();

      expect(row?.createdAt).toBeInstanceOf(Date);
      expect(row!.createdAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(row!.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(row?.deletedAt).toBeNull();
    });

    it('moves updated_at on an update but leaves created_at alone', async () => {
      const [row] = await database.db.insert(widget).values({ label: 'a' }).returning();
      await new Promise((resolve) => setTimeout(resolve, 2));

      const [updated] = await database.db
        .update(widget)
        .set({ label: 'b' })
        .where(sql`${widget.id} = ${row!.id}`)
        .returning();

      expect(updated!.createdAt.getTime()).toBe(row!.createdAt.getTime());
      expect(updated!.updatedAt.getTime()).toBeGreaterThan(row!.updatedAt.getTime());
    });
  });
});

describe('databaseNotReadyReason', () => {
  let database: TestDatabase;

  beforeEach(() => {
    database = createTestDatabase();
  });

  afterEach(() => {
    database.close();
  });

  it('says nothing about a database that is open and fully migrated', () => {
    expect(databaseNotReadyReason(database.db)).toBeUndefined();
  });

  it('names the closed connection rather than throwing out of the probe', () => {
    database.close();

    expect(databaseNotReadyReason(database.db)).toMatch(/did not answer/);
  });

  /**
   * What this is actually for. The migrator runs before the listener opens, so a serving
   * process has migrated something; the question is whether it migrated the file it is now
   * reading. Removing the last row is what a file migrated by an older build looks like.
   */
  it('refuses a schema that is behind the build, which is a file from an older release', () => {
    // By rowid, not by the table's own id: drizzle declares that column SERIAL, which SQLite
    // gives numeric affinity rather than treating as a rowid alias, so every value in it is null.
    database.db.$client
      .prepare(
        'delete from __drizzle_migrations where rowid = (select max(rowid) from __drizzle_migrations)',
      )
      .run();

    expect(databaseNotReadyReason(database.db)).toMatch(/behind this build/);
  });
});
