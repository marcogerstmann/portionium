import type { Meal, MealItem, User } from '@portionium/schemas';

import { DomainError } from './errors.js';
import { resolveLocalDate } from './local-date.js';

/**
 * Building a meal. The shape of the parts is already guaranteed by the schemas, so what is
 * left here is the part a schema cannot express: that a meal means something only if it has
 * something in it, that the order the user typed is the order that gets stored, and which day
 * the whole thing belongs to.
 *
 * Ids and timestamps are not assigned here. The database mints those, see db/schema/base.ts.
 */

/** What a caller supplies for one item. Position is ours to assign, the rest is theirs. */
export type NewMealItem = Omit<MealItem, 'id' | 'mealId' | 'position'>;

/**
 * `localDate` is absent on purpose. It is derived from `loggedAt`, so accepting one would let a
 * caller hand over a day that contradicts the instant beside it.
 */
export type NewMeal = Omit<Meal, 'id' | 'localDate'> & { items: readonly NewMealItem[] };

/**
 * The only two things about a user that dating a meal depends on. Narrower than `User` because
 * the domain has no business seeing an email address to work out which day it is.
 */
export type MealDayContext = Pick<User, 'timezone' | 'dayBoundaryHour'>;

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
 *
 * `localDate` is resolved here for the same reason: it is derived from `loggedAt` and the
 * user's day boundary, so it is computed at the one point where both are in hand rather than
 * trusted from an adapter. Every meal in the database is therefore stamped by
 * resolveLocalDate, with no route left for a hand written day to get in.
 */
export function createMeal(
  { items, ...meal }: NewMeal,
  { timezone, dayBoundaryHour }: MealDayContext,
): ValidatedMeal {
  if (items.length === 0) {
    throw new DomainError('meal_has_no_items', 'A meal must contain at least one item.');
  }

  return {
    meal: { ...meal, localDate: resolveLocalDate(meal.loggedAt, timezone, dayBoundaryHour) },
    items: items.map((item, position) => ({ ...item, position })),
  };
}
