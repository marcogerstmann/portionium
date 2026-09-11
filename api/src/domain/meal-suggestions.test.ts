import { describe, expect, it } from 'vitest';

import { rankMealSuggestions, type SuggestionHistoryMeal } from './meal-suggestions.js';

const NOW = new Date('2026-06-15T12:00:00.000Z');

function meal(id: string, daysAgo: number, foodIds: readonly string[]): SuggestionHistoryMeal {
  return {
    id,
    loggedAt: new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000),
    items: foodIds.map((foodId) => ({ foodId })),
  };
}

describe('rankMealSuggestions', () => {
  it('ranks a composition eaten more often above one eaten once', () => {
    const meals = [meal('a1', 1, ['skyr']), meal('a2', 3, ['skyr']), meal('a3', 2, ['oats'])];

    const result = rankMealSuggestions(meals, 10, NOW);

    expect(result[0]?.items.map((item) => item.foodId)).toEqual(['skyr']);
  });

  it('treats the same foods in a different order, or repeated, as one composition', () => {
    const meals = [
      meal('a1', 1, ['bread', 'butter']),
      meal('a2', 2, ['butter', 'bread']),
      meal('a3', 3, ['bread', 'bread', 'butter']),
    ];

    expect(rankMealSuggestions(meals, 10, NOW)).toHaveLength(1);
  });

  it('points a suggestion at the most recently logged meal with that composition', () => {
    const meals = [meal('old', 10, ['skyr']), meal('new', 1, ['skyr'])];

    const result = rankMealSuggestions(meals, 10, NOW);

    expect(result[0]?.mealId).toBe('new');
  });

  it('lets a composition nobody eats anymore fade behind a newer habit', () => {
    // Eaten twice, two months ago, and never since, versus eaten twice in the last week.
    const abandoned = [meal('old1', 60, ['oats']), meal('old2', 65, ['oats'])];
    const current = [meal('new1', 1, ['skyr']), meal('new2', 6, ['skyr'])];

    const result = rankMealSuggestions([...abandoned, ...current], 10, NOW);

    expect(result[0]?.items.map((item) => item.foodId)).toEqual(['skyr']);
  });

  it('returns nothing for a caller with no history, rather than throwing', () => {
    expect(rankMealSuggestions([], 10, NOW)).toEqual([]);
  });

  it('caps the result at the requested limit', () => {
    const meals = ['a', 'b', 'c'].map((id, index) => meal(id, index, [id]));

    expect(rankMealSuggestions(meals, 2, NOW)).toHaveLength(2);
  });
});
