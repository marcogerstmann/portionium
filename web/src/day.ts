import {
  MEAL_TYPES,
  type LocalDate,
  type MealResponse,
  type MealType,
  type Timezone,
} from '@portionium/schemas';

import { CACHED_DAYS, shiftDate } from './db';

/**
 * The arithmetic the Today screen does before it renders anything: what order a day's meals go
 * in, which day paging lands on, and what a date is called.
 *
 * Separate from ./today.tsx because none of it needs React, a DOM or IndexedDB, which is what
 * lets it be tested as three plain functions. The screen itself is covered by the browser tests,
 * the same split ./db.ts describes.
 */

/** Where each meal type sits, so ordering by type is a lookup rather than a chain of branches. */
const TYPE_RANK = new Map(MEAL_TYPES.map((type, rank) => [type, rank]));

/**
 * A day's meals grouped by type, breakfast first, and by the moment they were logged inside a
 * type. Grouped by ordering rather than by nesting: two snacks are two rows that happen to be
 * adjacent and are each their own meal to open, delete or undo, and a nested shape would have
 * the screen unwrap it again to render exactly that.
 *
 * `loggedAt` is an ISO string in UTC, which sorts correctly as text, so there are no Dates to
 * make here and no timezone to get wrong.
 */
export function orderMeals(meals: readonly MealResponse[]): MealResponse[] {
  return [...meals].sort(
    (left, right) =>
      (TYPE_RANK.get(left.type) ?? 0) - (TYPE_RANK.get(right.type) ?? 0) ||
      left.loggedAt.localeCompare(right.loggedAt),
  );
}

/** What a meal type is called on screen. Listed, so a new type is a compile error here. */
export const MEAL_TYPE_LABELS: Record<MealType, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  snack: 'Snack',
};

/**
 * Which meal somebody is most likely logging at this moment, so the composer opens on it.
 *
 * Read in the user's own timezone rather than the device's, the same rule localDateFor follows:
 * a phone that travelled is still a person eating breakfast at home. `Intl.DateTimeFormat` is
 * the browser's own IANA database and `h23` is what makes midnight hour 0 rather than 24.
 *
 * The gaps between the meals are snacks rather than a nearest-meal guess, which is the honest
 * answer: eating at 16:00 is an afternoon snack and eating at 23:00 is a late one, and calling
 * either of them dinner is a pre-selection somebody has to undo. Being wrong here costs a tap,
 * which is exactly what this exists to save, so it only claims the hours it is sure about.
 */
export function mealTypeAt(instant: Date, timezone: Timezone): MealType {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);

  // By name rather than by position, the same reason localDateFor reads its parts that way: a
  // formatted hour can carry a separator or a marker, and a part is just the number.
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);

  if (hour >= 5 && hour < 11) {
    return 'breakfast';
  }

  if (hour >= 11 && hour < 15) {
    return 'lunch';
  }

  return hour >= 17 && hour < 22 ? 'dinner' : 'snack';
}

/**
 * Where paging one day in either direction lands.
 *
 * Bounded on both sides, and both bounds are the same promise: the last CACHED_DAYS days are on
 * the device, so those are the days this screen can show with no network. Forward stops at today
 * because there is nothing to have eaten yet, and back stops at the edge of the cache rather
 * than letting somebody page into a week that is only there when there is a connection. A
 * history older than the window is a screen with paging of its own, not this one.
 *
 * Returning the current date unchanged rather than refusing is what lets the caller wire this
 * straight to a key press: at the edge, the day simply does not move.
 */
export function pageTo(date: LocalDate, days: number, today: LocalDate): LocalDate {
  const moved = shiftDate(date, days);
  const earliest = shiftDate(today, -(CACHED_DAYS - 1));

  if (moved > today) {
    return today;
  }

  return moved < earliest ? earliest : moved;
}

/**
 * What to call a date on screen. The two days somebody actually looks at get a word, because
 * "Today" is what the screen is for and "Yesterday" is the one people page to; anything else
 * gets a weekday and a date, since inside one week the weekday is what a person remembers.
 *
 * Formatted in UTC on purpose. A LocalDate has already had a timezone applied to it and carries
 * none of its own, so parsing it as an instant and rendering that instant anywhere but UTC would
 * put a day either side of a boundary back on the wrong date.
 */
export function dayLabel(date: LocalDate, today: LocalDate): string {
  if (date === today) {
    return 'Today';
  }

  if (date === shiftDate(today, -1)) {
    return 'Yesterday';
  }

  return new Intl.DateTimeFormat(undefined, {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(`${date}T00:00:00Z`));
}
