import type { Category } from '@portionium/schemas';

export interface SuggestionEntry {
  foodId?: string | undefined;
  category?: Category | null | undefined;
  quantity?: number | undefined;
}

export interface SuggestionHistoryMeal {
  id: string;
  loggedAt: Date;
  entries: readonly SuggestionEntry[];
}

export interface MealSuggestion {
  mealId: string;
  entries: readonly SuggestionEntry[];
}

/**
 * Fourteen days, so a composition eaten daily and then abandoned drops out of the top within a
 * couple of weeks.
 */
const RECENCY_HALF_LIFE_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

function compositionKey(entries: readonly SuggestionEntry[]): string {
  return [...new Set(entries.map((entry) => entry.foodId ?? `:${entry.category ?? 'none'}`))]
    .sort()
    .join(' ');
}

export function rankMealSuggestions(
  meals: readonly SuggestionHistoryMeal[],
  limit: number,
  now: Date = new Date(),
): MealSuggestion[] {
  const groups = new Map<string, { score: number; latest: SuggestionHistoryMeal }>();

  for (const meal of meals) {
    if (meal.entries.length === 0) {
      continue;
    }

    const key = compositionKey(meal.entries);
    const ageDays = Math.max(0, (now.getTime() - meal.loggedAt.getTime()) / DAY_MS);
    const weight = 2 ** (-ageDays / RECENCY_HALF_LIFE_DAYS);

    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { score: weight, latest: meal });
    } else {
      group.score += weight;
      if (meal.loggedAt.getTime() > group.latest.loggedAt.getTime()) {
        group.latest = meal;
      }
    }
  }

  return [...groups.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ latest }) => ({ mealId: latest.id, entries: latest.entries }));
}
