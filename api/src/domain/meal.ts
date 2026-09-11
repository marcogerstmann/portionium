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
 * How far into the future `loggedAt` may sit before a meal is refused. Not zero: a phone's clock
 * running a few minutes ahead of the server's must not turn every "log this now" into a rejected
 * request. Backdating has no such limit, see the module comment on NewMeal.
 */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

function assertNotTooFarInFuture(loggedAt: Date): void {
  if (loggedAt.getTime() - Date.now() > FUTURE_TOLERANCE_MS) {
    throw new DomainError(
      'meal_logged_in_future',
      'A meal cannot be logged more than a few minutes in the future.',
    );
  }
}

/**
 * Validates a meal and normalises its items. Shared by createMeal and applyMealChanges below, so
 * an edit is held to exactly the invariants a create is, never a looser set.
 *
 * A meal with no items is rejected rather than stored empty. It would show up in every list and
 * every streak as a day the user logged something, while saying nothing about what they ate, and
 * no read path could tell it apart from a real meal. This is not a shape rule, an empty array is
 * a perfectly good array, which is why it is enforced here and not in the schema. The message
 * names the way out, deleting the meal, because that is the one silent alternative a caller
 * removing the last item might otherwise reach for and be surprised by.
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
    throw new DomainError(
      'meal_has_no_items',
      'A meal must contain at least one item. Delete the meal instead of removing its last one.',
    );
  }
  assertNotTooFarInFuture(meal.loggedAt);

  return {
    meal: { ...meal, localDate: resolveLocalDate(meal.loggedAt, timezone, dayBoundaryHour) },
    items: items.map((item, position) => ({ ...item, position })),
  };
}

/** What an edit may change. A field left out is a field nobody touched. */
export type MealChanges = Partial<Pick<NewMeal, 'type' | 'loggedAt' | 'notes' | 'items'>>;

/**
 * Merges an edit into what a meal already is, then runs the result through createMeal, so
 * PATCH /meals/{id} is held to the same invariants POST /meals is rather than a looser set:
 * still no empty item list, still no meal dated further into the future than clock skew allows,
 * and a local date freshly derived from whichever `loggedAt` wins.
 *
 * `items` absent leaves the current list exactly as it stands, position and all. `items` present
 * replaces it whole rather than being diffed against the current one, which is what lets a
 * caller add, remove and reorder items in a single PATCH: the array it sent is the array that
 * ends up stored.
 */
export function applyMealChanges(
  current: NewMeal,
  changes: MealChanges,
  context: MealDayContext,
): ValidatedMeal {
  return createMeal(
    {
      userId: current.userId,
      type: changes.type ?? current.type,
      loggedAt: changes.loggedAt ?? current.loggedAt,
      ...(changes.notes !== undefined
        ? { notes: changes.notes }
        : current.notes !== undefined
          ? { notes: current.notes }
          : {}),
      items: changes.items ?? current.items,
    },
    context,
  );
}
