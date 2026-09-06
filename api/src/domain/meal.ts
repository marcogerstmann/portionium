import type { Meal, MealItem } from '@portionium/schemas';

import { DomainError } from './errors.js';

/**
 * Building a meal. The shape of the parts is already guaranteed by the schemas, so what is
 * left here is the part a schema cannot express: that a meal means something only if it has
 * something in it, and that the order the user typed is the order that gets stored.
 *
 * Ids and timestamps are not assigned here. The database mints those, see db/schema/base.ts.
 */

/** What a caller supplies for one item. Position is ours to assign, the rest is theirs. */
export type NewMealItem = Omit<MealItem, 'id' | 'mealId' | 'position'>;

export type NewMeal = Omit<Meal, 'id'> & { items: readonly NewMealItem[] };

export type ValidatedMealItem = Omit<MealItem, 'id' | 'mealId'>;

export interface ValidatedMeal {
  meal: Omit<Meal, 'id'>;
  items: ValidatedMealItem[];
}

/**
 * Validates a meal and normalises its items.
 *
 * A meal with no items is rejected rather than stored empty. It would show up in every list and
 * every streak as a day the user logged something, while saying nothing about what they ate,
 * and no read path could tell it apart from a real meal. This is not a shape rule, an empty
 * array is a perfectly good array, which is why it is enforced here and not in the schema.
 *
 * Position comes from the array index, so it is always dense and always zero based. Callers do
 * not supply it, which is the only way to be sure no two items in one meal share a position.
 */
export function createMeal({ items, ...meal }: NewMeal): ValidatedMeal {
  if (items.length === 0) {
    throw new DomainError('meal_has_no_items', 'A meal must contain at least one item.');
  }

  return {
    meal,
    items: items.map((item, position) => ({ ...item, position })),
  };
}
