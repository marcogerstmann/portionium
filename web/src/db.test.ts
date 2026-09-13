import { type MealResponse } from '@portionium/schemas';
import { describe, expect, it } from 'vitest';

import { countColours, emptyDay, localDateFor, withMeal, withWeight } from './db';

/**
 * The pure half of the store. The Dexie half needs a real IndexedDB and is covered by the
 * browser tests the screens bring with them, see POR-43.
 */

/** A meal with one item per colour given, since the colours are all these tests look at. */
function meal(...categories: MealResponse['items'][number]['category'][]): MealResponse {
  return {
    id: '01930000-0000-7000-8000-000000000001',
    userId: '01930000-0000-7000-8000-0000000000ff',
    type: 'lunch',
    loggedAt: '2026-09-13T11:00:00.000Z',
    localDate: '2026-09-13',
    items: categories.map((category, position) => ({
      id: `01930000-0000-7000-8000-00000000010${position}`,
      foodId: `01930000-0000-7000-8000-00000000020${position}`,
      position,
      category,
    })),
  };
}

describe('localDateFor', () => {
  it('is the calendar date in the user timezone rather than in UTC', () => {
    // 23:30 UTC is already the next day in Berlin, which is the whole reason the timezone is
    // applied before the date is read.
    const date = localDateFor(new Date('2026-09-13T23:30:00Z'), 'Europe/Berlin', 0);

    expect(date).toBe('2026-09-14');
  });

  it('puts an hour before the boundary on the day before', () => {
    // 01:00 in Berlin with a 04:00 boundary is still the night of the 13th, which is what a
    // person logging a late snack means by it.
    const date = localDateFor(new Date('2026-09-14T01:00:00+02:00'), 'Europe/Berlin', 4);

    expect(date).toBe('2026-09-13');
  });

  it('puts the boundary hour itself on the new day', () => {
    const date = localDateFor(new Date('2026-09-14T04:00:00+02:00'), 'Europe/Berlin', 4);

    expect(date).toBe('2026-09-14');
  });

  it('rolls back across a month and a year boundary', () => {
    const date = localDateFor(new Date('2026-01-01T02:00:00+01:00'), 'Europe/Berlin', 4);

    expect(date).toBe('2025-12-31');
  });

  it('reads the offset in force at that instant rather than a fixed one', () => {
    // Berlin is +01:00 in January and +02:00 in July. Both of these are 00:30 local, so both
    // belong to the previous day under a 04:00 boundary, which only holds if the offset is
    // resolved per instant.
    const winter = localDateFor(new Date('2026-01-15T23:30:00Z'), 'Europe/Berlin', 4);
    const summer = localDateFor(new Date('2026-07-15T22:30:00Z'), 'Europe/Berlin', 4);

    expect(winter).toBe('2026-01-15');
    expect(summer).toBe('2026-07-15');
  });

  it('reads a zone west of UTC as its own day', () => {
    const date = localDateFor(new Date('2026-09-14T02:00:00Z'), 'America/New_York', 0);

    expect(date).toBe('2026-09-13');
  });
});

describe('countColours', () => {
  it('counts nothing as four zeroes rather than as absent', () => {
    expect(countColours([])).toEqual({ green: 0, yellow: 0, orange: 0, unclassified: 0 });
  });

  it('counts items across meals and files a missing colour as unclassified', () => {
    const counts = countColours([meal('green', 'green', null), meal('orange', 'yellow')]);

    expect(counts).toEqual({ green: 2, yellow: 1, orange: 1, unclassified: 1 });
  });
});

describe('withMeal', () => {
  it('appends the meal and recounts the day', () => {
    const day = withMeal(emptyDay('2026-09-13'), meal('green', 'yellow'));

    expect(day.meals).toHaveLength(1);
    expect(day.colourCounts).toEqual({ green: 1, yellow: 1, orange: 0, unclassified: 0 });
  });

  it('puts the newest meal last, the order the server lists them in', () => {
    const first = meal('green');
    const second = { ...meal('orange'), id: '01930000-0000-7000-8000-000000000002' };

    const day = withMeal(withMeal(emptyDay('2026-09-13'), first), second);

    expect(day.meals.map((entry) => entry.id)).toEqual([first.id, second.id]);
  });

  it('leaves the day it was given alone, so a render holding the old one is unaffected', () => {
    const before = emptyDay('2026-09-13');

    withMeal(before, meal('green'));

    expect(before.meals).toEqual([]);
  });
});

describe('withWeight', () => {
  it('replaces the reading rather than keeping both, the way the server reports a day', () => {
    const entry = {
      id: '01930000-0000-7000-8000-000000000003',
      userId: '01930000-0000-7000-8000-0000000000ff',
      weightKg: 81.4,
      localDate: '2026-09-13',
      recordedAt: '2026-09-13T06:00:00.000Z',
    };

    const day = withWeight(withWeight(emptyDay('2026-09-13'), entry), {
      ...entry,
      weightKg: 81.2,
    });

    expect(day.weightEntry?.weightKg).toBe(81.2);
  });
});
