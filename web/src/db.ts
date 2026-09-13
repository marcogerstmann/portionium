import {
  dayResponseSchema,
  foodResponseSchema,
  type Category,
  type ColourCounts,
  type DayResponse,
  type FoodResponse,
  type LocalDate,
  type MealResponse,
  type Timezone,
  type WeightEntryResponse,
} from '@portionium/schemas';
import Dexie, { type EntityTable } from 'dexie';
import { z } from 'zod';

import { request } from './api';

/**
 * What this client keeps on the device, and the one place IndexedDB is opened.
 *
 * Three tables, and each exists for a different reason. `days` is what makes a cold launch on a
 * train render something rather than a spinner. `foods` is what makes logging possible with no
 * network at all, because a meal references a food by id and a client with no catalog has no id
 * to reference. `outbox` is the queue of writes that have not reached the server yet, which is
 * the subject of docs/adr/010-pwa-and-offline-outbox.md and is drained by ./outbox.ts.
 *
 * The direction is one way and deliberately so. Writes go into the outbox and are replayed at
 * the server; reads are served from these tables first and then replaced by whatever the server
 * says. Nothing here ever wins an argument with the server, which is what keeps this a cache and
 * an outbox rather than a sync engine, see the ADR.
 *
 * Dexie rather than raw IndexedDB for the reason the ADR gives: the raw API is callback and
 * event based, has no schema migrations, and every transaction in it is written twice, once for
 * the happy path and once for `onerror`.
 */

/** One cached day, keyed by the local date it is about. See CACHED_DAYS for how many are kept. */
export interface CachedDay {
  date: LocalDate;
  day: DayResponse;
}

/**
 * One frequently eaten food, with the colour already resolved for this user. `rank` preserves
 * the order the server ranked them in, which is information the id order does not carry, see
 * api/src/domain/food-search.ts.
 */
export interface CachedFood {
  id: string;
  rank: number;
  food: FoodResponse;
}

/**
 * One write that has not been acknowledged by the server yet.
 *
 * `key` is a UUIDv7 minted once, at enqueue, and it is two things at once. It is the
 * `Idempotency-Key` this entry is sent under on every attempt, which is the whole reason a
 * retry cannot produce a second meal. And because a UUIDv7 sorts by the moment it was made, it
 * is also the queue order, so draining in order is reading this table by its primary key.
 *
 * `body` is the request as it will be sent, including the entity id for a meal. Minting that id
 * here rather than letting the server assign one is what lets a meal logged in a basement keep
 * its identity: the retry hands the server the same id rather than asking for a new one.
 */
export interface OutboxEntry {
  key: string;
  /** Below the API prefix, the way ./api.ts takes it. */
  path: string;
  /**
   * The verb. Absent on an entry written before this field existed, which is every entry queued
   * by the version that only ever posted, so a reader defaults it to POST rather than dropping
   * a meal somebody logged before they updated the app. Not indexed, so adding it needed no
   * Dexie version and no migration, see the `stores` block above.
   */
  method?: 'POST' | 'PUT' | 'DELETE';
  body: unknown;
  /**
   * What this write is about, `meal:<id>` or `weight:<date>`, so a screen can ask whether the
   * thing it is rendering has reached the server yet without reading the body and guessing.
   * Also what labels a rejected write in a list of them, see failedWrites in ./outbox.ts.
   *
   * Optional for the same reason `method` is: an entry queued by an earlier version has none,
   * and a missing pending mark is a better outcome than a screen that refuses to render.
   */
  subject?: string;
  /** Which day this write changes, so a successful send knows which cached day is now stale. */
  date: LocalDate;
  /** How many attempts have failed. Drives the backoff, see backoffMs in ./outbox.ts. */
  attempts: number;
  /** Epoch milliseconds. A drain leaves an entry alone until the clock passes this. */
  nextAttemptAt: number;
  /**
   * The server's own sentence, set when it refused in a way a retry cannot fix. Present means
   * this entry is out of the queue and is waiting for a person to look at it, never for another
   * attempt. Null is the normal state.
   */
  failure: string | null;
}

/**
 * How many days are kept. Seven, because that is the window the Today screen pages through
 * without a network, and an eighth day offline is a case nobody has.
 */
export const CACHED_DAYS = 7;

/**
 * How many frequent foods are kept. The server's own cap on a ranked answer is 50 and a ranked
 * list is only meaningful from the top, see foodSearchQuerySchema.
 */
export const CACHED_FOODS = 50;

/**
 * The database. Named without a version suffix: Dexie migrates between the `version()` blocks
 * below, so the name is the application's and not a particular schema's.
 *
 * Nothing here is opened at import time. Dexie connects on the first query, which is what lets
 * this module be imported by a unit test with no IndexedDB in sight.
 */
export const database = new Dexie('portionium') as Dexie & {
  days: EntityTable<CachedDay, 'date'>;
  foods: EntityTable<CachedFood, 'id'>;
  outbox: EntityTable<OutboxEntry, 'key'>;
};

/**
 * Only the indexed columns are listed, not every field. `outbox` needs none beyond its primary
 * key: the queue is read in order, which is the primary key order, and it is short enough that
 * an index on anything else would be a lookup structure over a handful of rows.
 */
database.version(1).stores({
  days: 'date',
  foods: 'id, rank',
  outbox: 'key',
});

/**
 * The calendar day an instant belongs to, for one user. The client side twin of
 * resolveLocalDate in api/src/domain/local-date.ts, and it has to agree with it: a meal logged
 * offline is stamped by the server when it finally arrives, so a client that disagreed about
 * which day it was would file the optimistic copy under one date and the real one under another.
 *
 * Two things make this less obvious than it looks, and they are the same two the server's
 * version calls out. A day starts at the user's boundary hour rather than at midnight, so a
 * meal at 01:00 belongs to the evening before. And an offset belongs to an instant in a zone
 * rather than to the zone, so it cannot be looked up once and reused.
 *
 * `Intl.DateTimeFormat` is what supplies both, and it is the browser's own copy of the IANA
 * database, so this needs no Temporal polyfill in the bundle. `formatToParts` rather than
 * `format` because the parts are read by name, which is immune to how a locale orders them, and
 * `h23` so that midnight is hour 0 rather than 24.
 */
export function localDateFor(instant: Date, timezone: Timezone, boundaryHour: number): LocalDate {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);

  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';

  const date = `${part('year')}-${part('month')}-${part('day')}`;

  return Number(part('hour')) >= boundaryHour ? date : shiftDate(date, -1);
}

/**
 * Calendar arithmetic on a date with no zone attached, done in UTC so that no offset and no DST
 * transition can reach it. The zone was already applied above, which is why moving a day here
 * is safe where adding 24 hours to the instant would not be: a day is 23 or 25 hours long twice
 * a year in most of the world, and paging between days must not skip or repeat one when it is.
 */
export function shiftDate(date: LocalDate, days: number): LocalDate {
  const midnight = new Date(`${date}T00:00:00Z`);
  midnight.setUTCDate(midnight.getUTCDate() + days);

  return midnight.toISOString().slice(0, 10);
}

/**
 * The day's colours, counted from its meals.
 *
 * Derived here rather than carried over from the cached copy, because an optimistic meal has to
 * change the summary the moment it is logged. The server computes the same four numbers from
 * the same items, so the copy this produces is replaced by an identical one on the next refresh.
 */
export function countColours(meals: readonly MealResponse[]): ColourCounts {
  const counts: ColourCounts = { green: 0, yellow: 0, orange: 0, unclassified: 0 };

  for (const meal of meals) {
    for (const item of meal.items) {
      counts[item.category ?? 'unclassified'] += 1;
    }
  }

  return counts;
}

/**
 * A day with one more meal on it, as the server will report it once the outbox has drained.
 *
 * This is the whole of "the UI never waits on the network": what a screen renders after logging
 * is this, not a response. Meals come back from the server ordered by when they were logged, so
 * a meal logged now belongs at the end.
 */
export function withMeal(
  day: DayResponse,
  meal: MealResponse,
  foods: readonly FoodResponse[],
): DayResponse {
  const meals = [...day.meals, meal];
  const known = new Set(day.foods.map((food) => food.id));
  const added = foods.filter((food) => meal.items.some((item) => item.foodId === food.id));

  return {
    ...day,
    meals,
    // The names this meal's items need, so the optimistic copy renders as words rather than as
    // identifiers. A food the device has never seen is simply absent, which the screen renders
    // the same way the server's answer would if the catalog entry had gone: see foodNames.
    foods: [...day.foods, ...added.filter((food) => !known.has(food.id))],
    colourCounts: countColours(meals),
  };
}

/**
 * A day with one meal taken off it, the optimistic half of deleting one.
 *
 * The foods are left alone rather than pruned. A name nobody renders costs a string, and the
 * refresh after the delete drains replaces the whole day anyway, so working out which foods no
 * other meal still names would be arithmetic with no reader.
 */
export function withoutMeal(day: DayResponse, mealId: string): DayResponse {
  const meals = day.meals.filter((meal) => meal.id !== mealId);

  return { ...day, meals, colourCounts: countColours(meals) };
}

/**
 * A day in which one food has been given a colour, the optimistic half of classifying one from
 * this screen. Every item naming that food takes the colour, which is what makes the dot, the
 * name beside it and the summary row at the top all change together on the tap rather than on
 * the refresh that follows it.
 */
export function withClassification(
  day: DayResponse,
  foodId: string,
  category: Category,
): DayResponse {
  const meals = day.meals.map((meal) => ({
    ...meal,
    items: meal.items.map((item) => (item.foodId === foodId ? { ...item, category } : item)),
  }));

  return {
    ...day,
    meals,
    foods: day.foods.map((food) => (food.id === foodId ? { ...food, category } : food)),
    colourCounts: countColours(meals),
  };
}

/** Every food a day names, by id, which is how an item's `foodId` becomes something readable. */
export function foodNames(day: DayResponse): Map<string, FoodResponse> {
  return new Map(day.foods.map((food) => [food.id, food]));
}

/**
 * A day with a weight reading on it. There is one slot rather than a list, so a second reading
 * on one day replaces the first here, which is what GET /days/{date} reports too.
 */
export function withWeight(day: DayResponse, weightEntry: WeightEntryResponse): DayResponse {
  return { ...day, weightEntry };
}

/** A day with nothing on it, so an optimistic write has something to be applied to. */
export function emptyDay(date: LocalDate): DayResponse {
  return { date, meals: [], weightEntry: null, colourCounts: countColours([]), foods: [] };
}

/** What is on the device for this day, or nothing if it has never been fetched or written. */
export async function cachedDay(date: LocalDate): Promise<DayResponse | undefined> {
  return (await database.days.get(date))?.day;
}

/** Replace what is on the device for this day. Used by a refresh and by an optimistic write. */
export async function putDay(day: DayResponse): Promise<void> {
  await database.days.put({ date: day.date, day });
}

/**
 * The server's answer, stored on the way past.
 *
 * The server is the source of truth for reads and this is where that is enforced: whatever a
 * write left in the cache optimistically is overwritten by what actually exists, including the
 * ids and colours the server assigned. A caller renders the cached copy first and then this.
 */
export async function refreshDay(date: LocalDate): Promise<DayResponse> {
  const day = await request(`/days/${date}`, dayResponseSchema);

  await putDay(day);
  await trimDays();

  return day;
}

/**
 * Fill the gaps in the window the Today screen pages through.
 *
 * Without this the only day on the device is the one somebody happened to open, and paging back
 * with no network would find nothing.
 *
 * Only the days that are missing, and never today. A launch on a phone that has been used this
 * week therefore costs no requests at all beyond the one the screen makes for the day it is
 * showing, where fetching the whole window every time would cost seven, every time, for six
 * answers that have not changed. Staleness is not this function's problem: the day somebody
 * actually looks at is refreshed by the screen that shows it, see the Today screen's own load.
 *
 * Sequential rather than in parallel, because this runs behind a screen that has already
 * rendered and nothing is waiting on it: six requests at once would only compete with the one
 * refresh a person is looking at. Every failure is swallowed, since a cache that could not be
 * warmed is the offline case rather than an error.
 */
export async function refreshRecentDays(today: LocalDate): Promise<void> {
  for (let back = 1; back < CACHED_DAYS; back += 1) {
    const date = shiftDate(today, -back);

    if ((await cachedDay(date)) === undefined) {
      await refreshDay(date).catch(() => undefined);
    }
  }
}

/**
 * Keep the newest CACHED_DAYS and drop the rest, so the cache does not grow for the lifetime of
 * an installed app. Sorted by date rather than by when a row was written, because the point of
 * the window is which days can be paged to offline.
 */
async function trimDays(): Promise<void> {
  const stale = await database.days.orderBy('date').reverse().offset(CACHED_DAYS).primaryKeys();

  if (stale.length > 0) {
    await database.days.bulkDelete(stale);
  }
}

/** The frequent foods on the device, in the order the server ranked them. */
export async function cachedFoods(): Promise<FoodResponse[]> {
  return (await database.foods.orderBy('rank').toArray()).map((cached) => cached.food);
}

/**
 * What this user eats most, with the colour already resolved for them.
 *
 * An empty `q` is what the search endpoint answers with a caller's most eaten foods, so this is
 * the same request an autocomplete makes before anything is typed rather than a second endpoint
 * invented for the cache, see foodSearchQuerySchema.
 *
 * Replaced wholesale in one transaction rather than merged. A food that has dropped out of
 * somebody's top fifty should leave the cache, and a merge would keep it there forever.
 */
export async function refreshFoods(): Promise<FoodResponse[]> {
  const foods = await request(`/foods/search?limit=${CACHED_FOODS}`, z.array(foodResponseSchema));

  await database.transaction('rw', database.foods, async () => {
    await database.foods.clear();
    await database.foods.bulkPut(foods.map((food, rank) => ({ id: food.id, rank, food })));
  });

  return foods;
}
