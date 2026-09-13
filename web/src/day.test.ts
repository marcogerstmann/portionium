import type { MealResponse, MealType } from '@portionium/schemas';
import { describe, expect, it } from 'vitest';

import { dayLabel, mealTypeAt, orderMeals, pageTo } from './day';
import { CACHED_DAYS } from './db';

/**
 * The arithmetic behind the Today screen. The screen itself needs a browser and is covered by
 * the Playwright specs, the same split src/db.test.ts describes.
 */

/** A meal is only its type and its instant here, which is all the ordering looks at. */
function meal(type: MealType, loggedAt: string): MealResponse {
  return {
    id: `${type}-${loggedAt}`,
    userId: '01930000-0000-7000-8000-0000000000ff',
    type,
    loggedAt,
    localDate: '2026-09-13',
    items: [],
  };
}

describe('orderMeals', () => {
  it('puts the types in the order a day is eaten, whatever order they were logged in', () => {
    const ordered = orderMeals([
      meal('dinner', '2026-09-13T18:00:00.000Z'),
      meal('snack', '2026-09-13T15:00:00.000Z'),
      meal('breakfast', '2026-09-13T06:00:00.000Z'),
      meal('lunch', '2026-09-13T11:00:00.000Z'),
    ]);

    expect(ordered.map((entry) => entry.type)).toEqual(['breakfast', 'lunch', 'dinner', 'snack']);
  });

  it('keeps two meals of one type together, oldest first', () => {
    const later = meal('snack', '2026-09-13T16:00:00.000Z');
    const earlier = meal('snack', '2026-09-13T10:00:00.000Z');

    const ordered = orderMeals([later, meal('lunch', '2026-09-13T12:00:00.000Z'), earlier]);

    expect(ordered.map((entry) => entry.id)).toEqual([
      'lunch-2026-09-13T12:00:00.000Z',
      earlier.id,
      later.id,
    ]);
  });

  it('leaves the array it was given alone, so a render holding the old one is unaffected', () => {
    const meals = [
      meal('snack', '2026-09-13T15:00:00.000Z'),
      meal('breakfast', '2026-09-13T06:00:00.000Z'),
    ];

    orderMeals(meals);

    expect(meals[0]?.type).toBe('snack');
  });
});

describe('pageTo', () => {
  const today = '2026-09-13';

  it('moves a day in either direction', () => {
    expect(pageTo('2026-09-12', -1, today)).toBe('2026-09-11');
    expect(pageTo('2026-09-12', 1, today)).toBe(today);
  });

  it('stops at today, because there is nothing ahead to have eaten', () => {
    expect(pageTo(today, 1, today)).toBe(today);
  });

  it('stops at the edge of what the device holds, so paging never leaves the cache', () => {
    const earliest = '2026-09-07';

    expect(CACHED_DAYS).toBe(7);
    expect(pageTo('2026-09-08', -1, today)).toBe(earliest);
    expect(pageTo(earliest, -1, today)).toBe(earliest);
  });
});

describe('dayLabel', () => {
  it('names the two days somebody actually pages between', () => {
    expect(dayLabel('2026-09-13', '2026-09-13', 'en-US')).toBe('Today');
    expect(dayLabel('2026-09-12', '2026-09-13', 'en-US')).toBe('Yesterday');
  });

  it('names them in German too, the same reason the dictionaries have a parity test', () => {
    expect(dayLabel('2026-09-13', '2026-09-13', 'de')).toBe('Heute');
    expect(dayLabel('2026-09-12', '2026-09-13', 'de')).toBe('Gestern');
  });

  it('gives anything older a weekday, read in UTC so no zone can move the date', () => {
    // 10 September 2026 is a Thursday. Rendered anywhere but UTC, a date parsed as midnight can
    // land on the day before, which is the bug localDateFor exists to prevent.
    expect(dayLabel('2026-09-10', '2026-09-13', 'en-US')).toContain('Thursday');
  });

  it('reads the weekday in whichever language Intl is handed', () => {
    expect(dayLabel('2026-09-10', '2026-09-13', 'de')).toContain('Donnerstag');
  });
});

describe('mealTypeAt', () => {
  /** 13 September 2026 is not a DST transition anywhere below, so the offsets are the plain ones. */
  const at = (utc: string) => new Date(`2026-09-13T${utc}:00Z`);

  it('claims the hours it is sure about', () => {
    // Berlin is UTC+2 in September, so each of these is two hours later where the person is.
    expect(mealTypeAt(at('06:00'), 'Europe/Berlin')).toBe('breakfast');
    expect(mealTypeAt(at('11:00'), 'Europe/Berlin')).toBe('lunch');
    expect(mealTypeAt(at('17:00'), 'Europe/Berlin')).toBe('dinner');
  });

  it('calls the gaps between them a snack rather than guessing at the nearest meal', () => {
    // 16:00 and 23:00 local. Both are snacks, and calling either one dinner would be a
    // pre-selection somebody has to undo, which is the tap this exists to save.
    expect(mealTypeAt(at('14:00'), 'Europe/Berlin')).toBe('snack');
    expect(mealTypeAt(at('21:00'), 'Europe/Berlin')).toBe('snack');
  });

  it('reads the hour in the user profile timezone and not the device one', () => {
    // One instant, three places, three meals: 05:00 in New York, 11:00 in Berlin, 18:00 in
    // Tokyo. A phone that travelled is still a person eating breakfast at home, which is why
    // this takes a timezone the same way localDateFor does.
    const instant = at('09:00');

    expect(mealTypeAt(instant, 'America/New_York')).toBe('breakfast');
    expect(mealTypeAt(instant, 'Europe/Berlin')).toBe('lunch');
    expect(mealTypeAt(instant, 'Asia/Tokyo')).toBe('dinner');
  });

  it('puts the small hours in the day that is ending, not in breakfast', () => {
    // 02:00 local. Somebody eating then has not started tomorrow, and the day boundary in their
    // profile says the same thing about which date it lands on, see localDateFor.
    expect(mealTypeAt(at('00:00'), 'Europe/Berlin')).toBe('snack');
  });
});
