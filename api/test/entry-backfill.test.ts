import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import SQLite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it, onTestFinished } from 'vitest';

import { openDatabase } from '../src/db/client.js';
import { resolveClassification } from '../src/domain/classification.js';

const MIGRATION = '0009_rename_meal_item_to_entry_and_stamp_category';

const USER_A = '0199a000-0000-7000-8000-0000000000a1';
const USER_B = '0199a000-0000-7000-8000-0000000000b1';

interface Verdict {
  id: string;
  userId: string | null;
  category: 'green' | 'yellow' | 'orange';
  source: 'seed' | 'ai_text' | 'ai_vision' | 'user';
  createdAt: Date;
}

function foldersBefore(directory: string): string {
  const source = fileURLToPath(new URL('../drizzle', import.meta.url));
  const before = join(directory, 'drizzle');
  mkdirSync(join(before, 'meta'), { recursive: true });

  const journal = JSON.parse(readFileSync(join(source, 'meta/_journal.json'), 'utf8')) as {
    entries: { idx: number; tag: string }[];
  };
  const targetIdx = journal.entries.find((entry) => entry.tag === MIGRATION)?.idx;
  const earlier = journal.entries.filter((entry) => entry.idx < (targetIdx ?? 0));
  for (const entry of earlier) {
    copyFileSync(join(source, `${entry.tag}.sql`), join(before, `${entry.tag}.sql`));
  }
  writeFileSync(
    join(before, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: earlier }),
  );

  return before;
}

describe('the migration that gives every entry a colour', () => {
  it('agrees with resolveClassification row for row, for both accounts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'portionium-entry-backfill-'));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));

    const path = join(directory, 'test.db');
    const old = new SQLite(path);
    old.pragma('foreign_keys = ON');
    migrate(drizzle(old), { migrationsFolder: foldersBefore(directory) });

    const t = Date.parse('2026-04-01T10:00:00.000Z');
    const id = (suffix: string) => `0199a000-0000-7000-8000-0000000${suffix.padStart(5, '0')}`;

    for (const [user, email] of [
      [USER_A, 'a@example.de'],
      [USER_B, 'b@example.de'],
    ]) {
      old
        .prepare(
          'insert into user (id, created_at, updated_at, email, display_name, role, timezone, day_boundary_hour, password_hash) values (?,?,?,?,?,?,?,?,?)',
        )
        .run(user, t, t, email, 'Somebody', 'user', 'Europe/Berlin', 4, 'not-a-real-hash');
    }

    const foods = ['f1', 'f2', 'f3', 'f4', 'f5'].map((name) => id(name));
    for (const food of foods) {
      old
        .prepare('insert into food (id, created_at, updated_at, name, kind) values (?,?,?,?,?)')
        .run(food, t, t, `Food ${food.slice(-2)}`, 'ingredient');
    }

    const verdicts: Verdict[] = [];
    let sequence = 0;
    const say = (
      food: string,
      category: Verdict['category'],
      source: Verdict['source'],
      userId: string | null,
      offsetMs: number,
    ) => {
      const row: Verdict = {
        id: id(`c${++sequence}`),
        userId,
        category,
        source,
        createdAt: new Date(t + offsetMs),
      };
      old
        .prepare(
          'insert into food_classification (id, created_at, updated_at, food_id, user_id, category, source) values (?,?,?,?,?,?,?)',
        )
        .run(row.id, t + offsetMs, t + offsetMs, food, userId, category, source);
      verdicts.push(row);

      return row;
    };

    const byFood = new Map<string, Verdict[]>(foods.map((food) => [food, []]));
    const record = (food: string, row: Verdict) => byFood.get(food)?.push(row);

    record(foods[0]!, say(foods[0]!, 'green', 'seed', null, -9000));

    record(foods[1]!, say(foods[1]!, 'green', 'seed', null, -9000));
    record(foods[1]!, say(foods[1]!, 'yellow', 'ai_text', null, -5000));

    record(foods[2]!, say(foods[2]!, 'green', 'seed', null, -9000));
    record(foods[2]!, say(foods[2]!, 'yellow', 'ai_vision', null, -5000));
    record(foods[2]!, say(foods[2]!, 'orange', 'user', USER_A, -1000));
    record(foods[2]!, say(foods[2]!, 'green', 'user', USER_B, -1000));

    record(foods[3]!, say(foods[3]!, 'orange', 'seed', null, -9000));
    const withdrawn = say(foods[3]!, 'green', 'user', USER_A, -5000);
    record(foods[3]!, withdrawn);
    old
      .prepare(
        'insert into food_classification_withdrawal (id, created_at, updated_at, food_id, user_id) values (?,?,?,?,?)',
      )
      .run(id('w1'), t - 1000, t - 1000, foods[3]!, USER_A);

    let entries = 0;
    for (const [user, meal] of [
      [USER_A, id('ma1')],
      [USER_B, id('mb1')],
    ]) {
      old
        .prepare(
          'insert into meal (id, created_at, updated_at, user_id, type, logged_at, local_date) values (?,?,?,?,?,?,?)',
        )
        .run(meal, t, t, user, 'lunch', t, '2026-04-01');
      for (const [position, food] of foods.entries()) {
        old
          .prepare(
            'insert into meal_item (id, created_at, updated_at, meal_id, food_id, position) values (?,?,?,?,?,?)',
          )
          .run(id(`e${++entries}`), t, t, meal, food, position);
      }
    }
    old.close();

    const upgraded = openDatabase(path);
    onTestFinished(() => upgraded.close());

    const rows = upgraded.db.$client
      .prepare(
        'select m.user_id as userId, e.food_id as foodId, e.category as category from entry e join meal m on m.id = e.meal_id order by m.user_id, e.position',
      )
      .all() as { userId: string; foodId: string; category: string | null }[];

    expect(rows).toHaveLength(foods.length * 2);

    const expected = rows.map((row) => {
      const candidates = (byFood.get(row.foodId) ?? []).filter(
        (verdict) => verdict.id !== withdrawn.id || row.userId !== USER_A,
      );

      return resolveClassification(candidates, row.userId)?.category ?? null;
    });

    expect(rows.map((row) => row.category)).toEqual(expected);

    expect(rows.filter((row) => row.userId === USER_A).map((row) => row.category)).toEqual([
      'green',
      'yellow',
      'orange',
      'orange',
      null,
    ]);
    expect(rows.filter((row) => row.userId === USER_B).map((row) => row.category)).toEqual([
      'green',
      'yellow',
      'green',
      'orange',
      null,
    ]);
  });
});
