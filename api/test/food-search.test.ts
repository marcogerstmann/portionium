import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import SQLite from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';

import { openDatabase } from '../src/db/client.js';
import { searchFoods } from '../src/db/food-search.js';
import { foodTable, mealTable } from '../src/db/schema/index.js';
import { createTestFixtures, type TestFixtures } from './helpers/fixtures.js';

const FOOD_SEARCH_MIGRATION = '0005_add_food_search_index';
const EXISTING_FOOD_ID = '0199a000-0000-7000-8000-000000000001';
const EXISTING_USER_ID = '0199a000-0000-7000-8000-0000000000ff';

let fixtures: TestFixtures;

beforeEach(() => {
  fixtures = createTestFixtures();
});

afterEach(() => {
  fixtures.close();
});

function search(query: string, limit = 20): string[] {
  return searchFoods(fixtures.db, { userId: fixtures.userA.id, query, limit }).map(
    (food) => food.name,
  );
}

describe('finding a food', () => {
  it('matches inside a word, which is what a prefix index could not do', () => {
    fixtures.create.food({ name: 'Magerquark' });

    expect(search('quark')).toEqual(['Magerquark']);
  });

  it('matches across a space', () => {
    fixtures.create.food({ name: 'Peanut Butter' });

    expect(search('nut but')).toEqual(['Peanut Butter']);
  });

  it('ignores case, including on the vowels SQLite alone would get wrong', () => {
    fixtures.create.food({ name: 'Müsli' });

    expect(search('MÜSLI')).toEqual(['Müsli']);
    expect(search('müs')).toEqual(['Müsli']);
  });

  it('answers a query shorter than a trigram with a prefix match', () => {
    fixtures.create.food({ name: 'Skyr' });
    fixtures.create.food({ name: 'Quark' });

    expect(search('sk')).toEqual(['Skyr']);
    expect(search('s')).toEqual(['Skyr']);
  });

  it('forgives one mistake in a short name, whichever of the four it is', () => {
    fixtures.create.food({ name: 'Skyr' });

    expect(search('skyz')).toEqual(['Skyr']);
    expect(search('syr')).toEqual(['Skyr']);
    expect(search('skyyr')).toEqual(['Skyr']);
    expect(search('sykr')).toEqual(['Skyr']);
  });

  it('does not forgive two', () => {
    fixtures.create.food({ name: 'Skyr' });

    expect(search('sykz')).toEqual([]);
  });

  it('never returns a deleted food', () => {
    const skyr = fixtures.create.food({ name: 'Skyr' });
    fixtures.db
      .update(foodTable)
      .set({ deletedAt: new Date() })
      .where(eq(foodTable.id, skyr.id))
      .run();

    expect(search('skyr')).toEqual([]);
    expect(search('sk')).toEqual([]);
    expect(search('')).toEqual([]);
  });

  it('finds an entry the moment it is added, without anything writing to the index', () => {
    expect(search('skyr')).toEqual([]);

    fixtures.create.food({ name: 'Skyr' });

    expect(search('skyr')).toEqual(['Skyr']);
  });

  it('follows a rename, under the new name and not the old one', () => {
    const food = fixtures.create.food({ name: 'Skyr' });

    fixtures.db
      .update(foodTable)
      .set({ name: 'Magerquark' })
      .where(eq(foodTable.id, food.id))
      .run();

    expect(search('quark')).toEqual(['Magerquark']);
    expect(search('skyr')).toEqual([]);
  });
});

describe('the order results come back in', () => {
  it('puts an exact match first, above a food the caller eats constantly', () => {
    const skyr = fixtures.create.food({ name: 'Skyr' });
    const vanilla = fixtures.create.food({ name: 'Skyr Vanilla' });
    for (let i = 0; i < 5; i += 1) {
      fixtures.create.meal(fixtures.userA, { entries: [{ foodId: vanilla.id }] });
    }

    expect(search('skyr')).toEqual([skyr.name, vanilla.name]);
  });

  it("prefers the caller's own foods, most recently eaten first", () => {
    const popular = fixtures.create.food({ name: 'Skyr Plain' });
    const mine = fixtures.create.food({ name: 'Skyr Mango' });
    const older = fixtures.create.food({ name: 'Skyr Vanilla' });

    for (let i = 0; i < 10; i += 1) {
      fixtures.create.meal(fixtures.userB, { entries: [{ foodId: popular.id }] });
    }
    fixtures.create.meal(fixtures.userA, {
      loggedAt: new Date('2026-09-01T08:00:00Z'),
      entries: [{ foodId: older.id }],
    });
    fixtures.create.meal(fixtures.userA, {
      loggedAt: new Date('2026-09-09T08:00:00Z'),
      entries: [{ foodId: mine.id }],
    });

    expect(search('skyr')).toEqual(['Skyr Mango', 'Skyr Vanilla', 'Skyr Plain']);

    expect(
      searchFoods(fixtures.db, { userId: fixtures.userB.id, query: 'skyr', limit: 20 }).map(
        (food) => food.name,
      ),
    ).toEqual(['Skyr Plain', 'Skyr Mango', 'Skyr Vanilla']);
  });

  it('falls back to how much the instance eats a food', () => {
    const quiet = fixtures.create.food({ name: 'Skyr Quiet' });
    const loud = fixtures.create.food({ name: 'Skyr Loud' });
    for (let i = 0; i < 3; i += 1) {
      fixtures.create.meal(fixtures.userB, { entries: [{ foodId: loud.id }] });
    }
    fixtures.create.meal(fixtures.userB, { entries: [{ foodId: quiet.id }] });

    expect(search('skyr')).toEqual(['Skyr Loud', 'Skyr Quiet']);
  });

  it('does not count a meal the user deleted towards what they eat', () => {
    const deleted = fixtures.create.food({ name: 'Skyr Deleted' });
    const kept = fixtures.create.food({ name: 'Skyr Kept' });
    const { meal } = fixtures.create.meal(fixtures.userA, { entries: [{ foodId: deleted.id }] });
    fixtures.create.meal(fixtures.userA, {
      loggedAt: new Date('2020-01-01T08:00:00Z'),
      entries: [{ foodId: kept.id }],
    });

    fixtures.db
      .update(mealTable)
      .set({ deletedAt: new Date() })
      .where(eq(mealTable.id, meal.id))
      .run();

    expect(search('skyr')).toEqual(['Skyr Kept', 'Skyr Deleted']);
  });

  it('honours the limit', () => {
    for (const name of ['Skyr A', 'Skyr B', 'Skyr C']) {
      fixtures.create.food({ name });
    }

    expect(search('skyr', 2)).toHaveLength(2);
  });
});

describe('an empty query', () => {
  it("answers with the caller's most eaten foods rather than an error", () => {
    const rare = fixtures.create.food({ name: 'Aardvark Steak' });
    const usual = fixtures.create.food({ name: 'Zucchini' });
    for (let i = 0; i < 3; i += 1) {
      fixtures.create.meal(fixtures.userA, { entries: [{ foodId: usual.id }] });
    }
    fixtures.create.meal(fixtures.userA, { entries: [{ foodId: rare.id }] });

    expect(search('').slice(0, 2)).toEqual(['Zucchini', 'Aardvark Steak']);
  });

  it('degrades to what the instance eats when the caller has no history', () => {
    fixtures.create.food({ name: 'Aardvark Steak' });
    const popular = fixtures.create.food({ name: 'Zucchini' });
    fixtures.create.meal(fixtures.userB, { entries: [{ foodId: popular.id }] });

    expect(search('')[0]).toBe('Zucchini');
  });

  it('still answers on a fresh install, where nobody has eaten anything', () => {
    fixtures.create.food({ name: 'Zucchini' });
    fixtures.create.food({ name: 'Aardvark Steak' });

    expect(search('')).toEqual(['Aardvark Steak', 'Zucchini']);
  });

  it('treats a box holding only whitespace as empty', () => {
    fixtures.create.food({ name: 'Zucchini' });

    expect(search('   ')).toEqual(['Zucchini']);
  });
});

describe('at the size a catalog actually reaches', () => {
  const CATALOG_SIZE = 5000;
  const BUDGET_MS = 50;

  const WORDS = [
    'Skyr',
    'Quark',
    'Brot',
    'Käse',
    'Apfel',
    'Nudeln',
    'Reis',
    'Suppe',
    'Salat',
    'Milch',
    'Butter',
    'Wurst',
    'Joghurt',
    'Müsli',
    'Banane',
    'Kaffee',
    'Wasser',
    'Kuchen',
    'Pizza',
    'Eier',
  ];

  function medianDuration(run: () => unknown): number {
    const samples: number[] = [];
    for (let i = 0; i < 15; i += 1) {
      const started = performance.now();
      run();
      samples.push(performance.now() - started);
    }

    return samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;
  }

  it(`answers within ${BUDGET_MS} ms over ${CATALOG_SIZE} entries`, () => {
    const rows = Array.from({ length: CATALOG_SIZE }, (_, i) => ({
      name: `${WORDS[i % WORDS.length]!} ${WORDS[(i * 7 + 3) % WORDS.length]!} ${i}`,
      kind: 'ingredient' as const,
    }));
    for (let i = 0; i < rows.length; i += 500) {
      fixtures.db
        .insert(foodTable)
        .values(rows.slice(i, i + 500))
        .run();
    }

    const catalog = fixtures.db.select({ id: foodTable.id }).from(foodTable).all();
    for (let i = 0; i < 300; i += 1) {
      fixtures.create.meal(fixtures.userA, { entries: [{ foodId: catalog[i * 3]!.id }] });
      fixtures.create.meal(fixtures.userB, { entries: [{ foodId: catalog[i * 5]!.id }] });
    }

    const slowest = ['', 'sky', 'skyr', 'sykr', 'sk', 'käse', 'zzzzz'].map((query) => ({
      query,
      ms: medianDuration(() =>
        searchFoods(fixtures.db, { userId: fixtures.userA.id, query, limit: 20 }),
      ),
    }));

    for (const { query, ms } of slowest) {
      expect(ms, `searching for ${JSON.stringify(query)} took ${ms.toFixed(1)} ms`).toBeLessThan(
        BUDGET_MS,
      );
    }
  }, 60_000);
});

describe('the migration that adds the index', () => {
  it('backfills the entries that were in the catalog before it ran', () => {
    const directory = mkdtempSync(join(tmpdir(), 'portionium-backfill-'));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));

    const source = fileURLToPath(new URL('../drizzle', import.meta.url));
    const before = join(directory, 'drizzle');
    mkdirSync(join(before, 'meta'), { recursive: true });
    const journal = JSON.parse(readFileSync(join(source, 'meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    const targetIdx = journal.entries.find((entry) => entry.tag === FOOD_SEARCH_MIGRATION)?.idx;
    const earlier = journal.entries.filter((entry) => entry.idx < (targetIdx ?? 0));
    for (const entry of earlier) {
      copyFileSync(join(source, `${entry.tag}.sql`), join(before, `${entry.tag}.sql`));
    }
    writeFileSync(
      join(before, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries: earlier }),
    );

    const path = join(directory, 'test.db');
    const old = new SQLite(path);
    old.pragma('foreign_keys = ON');
    migrate(drizzle(old), { migrationsFolder: before });
    old
      .prepare('insert into food (id, name, kind, created_at, updated_at) values (?, ?, ?, ?, ?)')
      .run(EXISTING_FOOD_ID, 'Magerquark', 'ingredient', Date.now(), Date.now());
    old.close();

    const upgraded = openDatabase(path);
    onTestFinished(() => upgraded.close());

    expect(
      searchFoods(upgraded.db, { userId: EXISTING_USER_ID, query: 'quark', limit: 10 }).map(
        (food) => food.name,
      ),
    ).toEqual(['Magerquark']);
  });
});
