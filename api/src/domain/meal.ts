import type { Entry, Meal, User } from '@portionium/schemas';

import { DomainError } from './errors.js';
import { resolveLocalDate } from './local-date.js';

export type NewEntry = Omit<Entry, 'id' | 'mealId' | 'position'>;

/**
 * `localDate` is absent on purpose: it is derived from `loggedAt`, and accepting one would let a
 * caller contradict the other.
 */
export type NewMeal = Omit<Meal, 'id' | 'localDate'> & { entries: readonly NewEntry[] };

export type MealDayContext = Pick<User, 'timezone' | 'dayBoundaryHour'>;

export type ValidatedEntry = Omit<Entry, 'id' | 'mealId'>;

export interface ValidatedMeal {
  meal: Omit<Meal, 'id'>;
  entries: ValidatedEntry[];
}

/**
 * Not zero: a phone clock running a few minutes ahead must not turn every "log this now" into a
 * rejection. Backdating is unlimited.
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

export function createMeal(
  { entries, ...meal }: NewMeal,
  { timezone, dayBoundaryHour }: MealDayContext,
): ValidatedMeal {
  if (entries.length === 0) {
    throw new DomainError(
      'meal_has_no_entries',
      'A meal must contain at least one entry. Delete the meal instead of removing its last one.',
    );
  }
  assertNotTooFarInFuture(meal.loggedAt);

  return {
    meal: { ...meal, localDate: resolveLocalDate(meal.loggedAt, timezone, dayBoundaryHour) },
    entries: entries.map((entry, position) => ({ ...entry, position })),
  };
}

export function validateFavouriteEntries(entries: readonly unknown[]): void {
  if (entries.length === 0) {
    throw new DomainError(
      'favourite_has_no_entries',
      'A favourite must contain at least one entry. Delete it instead of clearing its entries.',
    );
  }
}

export type MealChanges = Partial<Pick<NewMeal, 'type' | 'loggedAt' | 'notes' | 'entries'>>;

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
      entries: changes.entries ?? current.entries,
    },
    context,
  );
}
