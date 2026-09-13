import type { FoodResponse } from '@portionium/schemas';

/**
 * Finding a food in what is already on the device, which is the half of the search box that
 * answers before the server has been asked and the whole of it when there is no network.
 *
 * The rows this runs over are ./db.ts's `foods` table: the caller's most eaten entries, in the
 * order the server ranked them, see refreshFoods. That ordering is the useful part and this
 * function deliberately preserves it, so two names that answer the query equally well come back
 * in the order somebody actually eats them.
 *
 * ponytail: substring and prefix matching, and no typo tolerance. The server has a trigram
 * index and a Damerau walk for that, see api/src/domain/food-search.ts, and a second
 * implementation of a ranking is a second answer to one search box. What is scanned here is
 * fifty names the person picked out of their own diet, where a typo is visibly a typo. If the
 * offline case ever needs to forgive one, the move is to lift that domain module into
 * packages/schemas so both sides run the same code, not to write a second one here.
 */

/**
 * The server's own spelling of "these two names are the same food", see normalizeFoodName in
 * api/src/domain/food.ts. Copied rather than imported because `web` may not import from `api`,
 * and it has to agree with it or the inline create below offers to add a food that exists.
 */
export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * How well one name answers the query. Lower is better, undefined is not an answer at all.
 *
 * The word prefix is the tier that earns its place: `but` should find `Erdnussbutter` and
 * `kohl` should find `Blumenkohl`, and a plain substring test would rank those level with a
 * match in the middle of a word. Both are still matches, they just come after.
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

/**
 * The cached entries that answer this query, best first.
 *
 * An empty query is every entry in the order it was cached, which is what an autocomplete shows
 * before anything has been typed into it: the caller's own most eaten foods. The same answer
 * GET /foods/search gives an empty `q`, so opening the field costs no request to be useful.
 *
 * `sort` is stable, so entries on one tier keep the frequency order they arrived in.
 */
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

/**
 * Whether a query names something the catalog does not have yet, and is therefore worth
 * offering to add.
 *
 * Compared against the results rather than against the whole cache, because the results are
 * what is on screen: offering "Add Skyr" underneath a row that says Skyr is how a shared
 * catalog collects near duplicates. The server refuses to make one anyway, see POST /foods,
 * which answers 200 with the entry that already means this rather than creating a second.
 */
export function isNewName(results: readonly FoodResponse[], query: string): boolean {
  const target = normalizeName(query);

  return target !== '' && !results.some((food) => normalizeName(food.name) === target);
}
