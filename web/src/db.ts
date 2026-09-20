import {
  dayResponseSchema,
  favouriteResponseSchema,
  foodResponseSchema,
  mealSuggestionResponseSchema,
  pageSchema,
  type Category,
  type ColourCounts,
  type DayResponse,
  type FavouriteResponse,
  type FoodResponse,
  type LocalDate,
  type MealResponse,
  type MealSuggestionResponse,
  type MealType,
  type Timezone,
  type WeeklyBudgetStatus,
  type WeightEntryResponse,
} from '@portionium/schemas';
import Dexie, { type EntityTable } from 'dexie';
import { z } from 'zod';

import { request } from './api';

export interface CachedDay {
  date: LocalDate;
  day: DayResponse;
}

export interface CachedStats {
  name: string;
  value: unknown;
}

export interface CachedFood {
  id: string;
  rank: number;
  food: FoodResponse;
}

export interface CachedFavourite {
  id: string;
  rank: number;
  favourite: FavouriteResponse;
}

export interface CachedSuggestions {
  type: MealType;
  suggestions: MealSuggestionResponse[];
}

export interface OutboxEntry {
  key: string;
  path: string;
  method?: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body: unknown;
  subject?: string;
  date: LocalDate;
  attempts: number;
  nextAttemptAt: number;
  failure: string | null;
}

export const CACHED_DAYS = 7;

export const CACHED_FOODS = 50;

export const database = new Dexie('portionium') as Dexie & {
  days: EntityTable<CachedDay, 'date'>;
  foods: EntityTable<CachedFood, 'id'>;
  favourites: EntityTable<CachedFavourite, 'id'>;
  suggestions: EntityTable<CachedSuggestions, 'type'>;
  outbox: EntityTable<OutboxEntry, 'key'>;
  stats: EntityTable<CachedStats, 'name'>;
};

database.version(1).stores({
  days: 'date',
  foods: 'id, rank',
  outbox: 'key',
});

/** A version states only what changed; Dexie carries the rest forward. */
database.version(2).stores({ stats: 'name' });

database.version(3).stores({ favourites: 'id, rank', suggestions: 'type' });

/**
 * The client side twin of resolveLocalDate in api/src/domain/local-date.ts. The two have to agree,
 * or an offline meal is filed under one date locally and another on the server.
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

/** Done in UTC so no offset and no DST transition can move a zoneless date. */
export function shiftDate(date: LocalDate, days: number): LocalDate {
  const midnight = new Date(`${date}T00:00:00Z`);
  midnight.setUTCDate(midnight.getUTCDate() + days);

  return midnight.toISOString().slice(0, 10);
}

export function countColours(meals: readonly MealResponse[]): ColourCounts {
  const counts: ColourCounts = { green: 0, yellow: 0, orange: 0, unclassified: 0 };

  for (const meal of meals) {
    for (const entry of meal.entries) {
      counts[entry.category ?? 'unclassified'] += 1;
    }
  }

  return counts;
}

function withWeekCounts(day: DayResponse, meals: readonly MealResponse[]): WeeklyBudgetStatus {
  const before = day.colourCounts;
  const after = countColours(meals);

  const moved = (category: Category) => {
    const { limit } = day.budget[category];
    const count = day.budget[category].count - before[category] + after[category];

    return { limit, count, remaining: limit === null ? null : limit - count };
  };

  return {
    green: moved('green'),
    yellow: moved('yellow'),
    orange: moved('orange'),
    unclassified: day.budget.unclassified - before.unclassified + after.unclassified,
  };
}

export function withMeal(
  day: DayResponse,
  meal: MealResponse,
  foods: readonly FoodResponse[],
): DayResponse {
  const meals = day.meals.some((current) => current.id === meal.id)
    ? day.meals.map((current) => (current.id === meal.id ? meal : current))
    : [...day.meals, meal];
  const known = new Set(day.foods.map((food) => food.id));
  const added = foods.filter((food) => meal.entries.some((entry) => entry.foodId === food.id));

  return {
    ...day,
    meals,
    foods: [...day.foods, ...added.filter((food) => !known.has(food.id))],
    colourCounts: countColours(meals),
    budget: withWeekCounts(day, meals),
  };
}

export function withoutMeal(day: DayResponse, mealId: string): DayResponse {
  const meals = day.meals.filter((meal) => meal.id !== mealId);

  return { ...day, meals, colourCounts: countColours(meals), budget: withWeekCounts(day, meals) };
}

export function withClassification(
  day: DayResponse,
  foodId: string,
  category: Category,
): DayResponse {
  const meals = day.meals.map((meal) => ({
    ...meal,
    entries: meal.entries.map((entry) =>
      entry.foodId === foodId && entry.category === null ? { ...entry, category } : entry,
    ),
  }));

  return {
    ...day,
    meals,
    foods: day.foods.map((food) => (food.id === foodId ? { ...food, category } : food)),
    colourCounts: countColours(meals),
    budget: withWeekCounts(day, meals),
  };
}

export function foodNames(day: DayResponse): Map<string, FoodResponse> {
  return new Map(day.foods.map((food) => [food.id, food]));
}

export function withWeight(day: DayResponse, weightEntry: WeightEntryResponse): DayResponse {
  return { ...day, weightEntry };
}

export function withoutWeight(day: DayResponse): DayResponse {
  return { ...day, weightEntry: null };
}

const NO_BUDGET: WeeklyBudgetStatus = {
  green: { limit: null, count: 0, remaining: null },
  yellow: { limit: null, count: 0, remaining: null },
  orange: { limit: null, count: 0, remaining: null },
  unclassified: 0,
};

export function emptyDay(date: LocalDate): DayResponse {
  return {
    date,
    meals: [],
    weightEntry: null,
    colourCounts: countColours([]),
    foods: [],
    budget: NO_BUDGET,
  };
}

/**
 * Parsed rather than cast: a row written by an older version of this app may no longer be a shape
 * this one understands, and a miss is the same outcome as a first launch.
 */
export async function cachedDay(date: LocalDate): Promise<DayResponse | undefined> {
  const parsed = dayResponseSchema.safeParse((await database.days.get(date))?.day);

  return parsed.success ? parsed.data : undefined;
}

export async function putDay(day: DayResponse): Promise<void> {
  await database.days.put({ date: day.date, day });
}

export async function refreshDay(date: LocalDate): Promise<DayResponse> {
  const day = await request(`/days/${date}`, dayResponseSchema);

  await putDay(day);
  await trimDays();

  return day;
}

export async function classifyCachedDays(
  verdicts: readonly { foodId: string; category: Category }[],
): Promise<void> {
  for (const date of await database.days.orderBy('date').primaryKeys()) {
    const day = await cachedDay(date);

    if (day !== undefined) {
      await putDay(
        verdicts.reduce(
          (current, verdict) => withClassification(current, verdict.foodId, verdict.category),
          day,
        ),
      );
    }
  }
}

export async function cachedStats<T extends z.ZodType>(
  name: string,
  schema: T,
): Promise<z.infer<T> | undefined> {
  const parsed = schema.safeParse((await database.stats.get(name))?.value);

  return parsed.success ? parsed.data : undefined;
}

export async function refreshStats<T extends z.ZodType>(
  name: string,
  path: string,
  schema: T,
): Promise<z.infer<T>> {
  const value: unknown = await request(path, schema);

  await database.stats.put({ name, value });

  return value as z.infer<T>;
}

export async function refreshRecentDays(today: LocalDate): Promise<void> {
  for (let back = 1; back < CACHED_DAYS; back += 1) {
    const date = shiftDate(today, -back);

    if ((await cachedDay(date)) === undefined) {
      await refreshDay(date).catch(() => undefined);
    }
  }
}

async function trimDays(): Promise<void> {
  const stale = await database.days.orderBy('date').reverse().offset(CACHED_DAYS).primaryKeys();

  if (stale.length > 0) {
    await database.days.bulkDelete(stale);
  }
}

export async function invalidateDays(): Promise<void> {
  await database.days.clear();
}

export async function cachedFoods(): Promise<FoodResponse[]> {
  return (await database.foods.orderBy('rank').toArray()).map((cached) => cached.food);
}

export async function refreshFoods(): Promise<FoodResponse[]> {
  const foods = await request(`/foods/search?limit=${CACHED_FOODS}`, z.array(foodResponseSchema));

  await database.transaction('rw', database.foods, async () => {
    await database.foods.clear();
    await database.foods.bulkPut(foods.map((food, rank) => ({ id: food.id, rank, food })));
  });

  return foods;
}

export async function cachedFavourites(): Promise<FavouriteResponse[]> {
  return (await database.favourites.orderBy('rank').toArray()).map((cached) => cached.favourite);
}

export async function refreshFavourites(): Promise<FavouriteResponse[]> {
  const { items } = await request('/meals/favourites', pageSchema(favouriteResponseSchema));

  await database.transaction('rw', database.favourites, async () => {
    await database.favourites.clear();
    await database.favourites.bulkPut(
      items.map((favourite, rank) => ({ id: favourite.id, rank, favourite })),
    );
  });

  return items;
}

export async function cachedSuggestions(type: MealType): Promise<MealSuggestionResponse[]> {
  return (await database.suggestions.get(type))?.suggestions ?? [];
}

export async function refreshSuggestions(type: MealType): Promise<MealSuggestionResponse[]> {
  const suggestions = await request(
    `/meals/suggestions?type=${type}`,
    z.array(mealSuggestionResponseSchema),
  );

  await database.suggestions.put({ type, suggestions });

  return suggestions;
}
