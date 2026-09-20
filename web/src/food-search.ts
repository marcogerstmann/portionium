import type { FoodResponse } from '@portionium/schemas';

/** Has to agree with normalizeFoodName in api/src/domain/food.ts. */
export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * No typo tolerance: the server has a trigram index and a Damerau walk, and two implementations of
 * one ranking are two answers to one search box.
 */
function rank(name: string, query: string): number | undefined {
  if (name === query) {
    return 0;
  }

  if (name.startsWith(query)) {
    return 1;
  }

  if (name.split(' ').some((word) => word.startsWith(query))) {
    return 2;
  }

  return name.includes(query) ? 3 : undefined;
}

export function matchFoods(foods: readonly FoodResponse[], query: string): FoodResponse[] {
  const target = normalizeName(query);

  if (target === '') {
    return [...foods];
  }

  return foods
    .flatMap((food) => {
      const tier = rank(normalizeName(food.name), target);

      return tier === undefined ? [] : [{ food, tier }];
    })
    .sort((left, right) => left.tier - right.tier)
    .map((match) => match.food);
}

export function isNewName(results: readonly FoodResponse[], query: string): boolean {
  const target = normalizeName(query);

  return target !== '' && !results.some((food) => normalizeName(food.name) === target);
}
