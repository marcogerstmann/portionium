import { type FoodResponse, type MealResponse } from '@portionium/schemas';
import { describe, expect, it } from 'vitest';

import {
  countColours,
  emptyDay,
  foodNames,
  localDateFor,
  shiftDate,
  withClassification,
  withMeal,
  withoutMeal,
  withoutWeight,
  withWeight,
} from './db';

function meal(...categories: MealResponse['entries'][number]['category'][]): MealResponse {
  return {
    id: '01930000-0000-7000-8000-000000000001',
    userId: '01930000-0000-7000-8000-0000000000ff',
    type: 'lunch',
    loggedAt: '2026-09-13T11:00:00.000Z',
    localDate: '2026-09-13',
    entries: categories.map((category, position) => ({
      id: `01930000-0000-7000-8000-00000000010${position}`,
      foodId: `01930000-0000-7000-8000-00000000020${position}`,
      position,
      category,
    })),
  };
}

describe('localDateFor', () => {
  it('is the calendar date in the user timezone rather than in UTC', () => {
    const date = localDateFor(new Date('2026-09-13T23:30:00Z'), 'Europe/Berlin', 0);

    expect(date).toBe('2026-09-14');
  });

  it('puts an hour before the boundary on the day before', () => {
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

function food(id: string, name: string): FoodResponse {
  return { id, name, kind: 'ingredient', category: 'green' };
}

const other: MealResponse = {
  ...meal('yellow'),
  id: '01930000-0000-7000-8000-0000000000aa',
  type: 'snack',
};

describe('withMeal', () => {
  it('appends the meal and recounts the day', () => {
    const day = withMeal(emptyDay('2026-09-13'), meal('green', 'yellow'), []);

    expect(day.meals).toHaveLength(1);
    expect(day.colourCounts).toEqual({ green: 1, yellow: 1, orange: 0, unclassified: 0 });
  });

  it('puts the newest meal last, the order the server lists them in', () => {
    const first = meal('green');
    const second = { ...meal('orange'), id: '01930000-0000-7000-8000-000000000002' };

    const day = withMeal(withMeal(emptyDay('2026-09-13'), first, []), second, []);

    expect(day.meals.map((entry) => entry.id)).toEqual([first.id, second.id]);
  });

  it('replaces a meal it already has rather than adding a second copy of it', () => {
    const before = meal('green', 'green');
    const after = {
      ...before,
      type: 'dinner' as const,
      entries: [before.entries[0]!, { ...before.entries[1]!, category: 'orange' as const }],
    };

    const day = withMeal(
      withMeal(withMeal(emptyDay('2026-09-13'), before, []), other, []),
      after,
      [],
    );

    expect(day.meals.map((entry) => entry.id)).toEqual([before.id, other.id]);
    expect(day.meals[0]).toEqual(after);
    expect(day.colourCounts).toEqual({ green: 1, yellow: 1, orange: 1, unclassified: 0 });
  });

  it('leaves the day it was given alone, so a render holding the old one is unaffected', () => {
    const before = emptyDay('2026-09-13');

    withMeal(before, meal('green'), []);

    expect(before.meals).toEqual([]);
  });

  it('carries in the names the new items need, and only those', () => {
    const added = meal('green');
    const eaten = added.entries[0]?.foodId ?? '';

    const day = withMeal(emptyDay('2026-09-13'), added, [
      food(eaten, 'Skyr'),
      food('01930000-0000-7000-8000-0000000009ff', 'Something else'),
    ]);

    expect(foodNames(day).get(eaten)?.name).toBe('Skyr');
    expect(day.foods).toHaveLength(1);
  });

  it('names a food once when a second meal eats it again', () => {
    const first = meal('green');
    const eaten = first.entries[0]?.foodId ?? '';
    const second = { ...first, id: '01930000-0000-7000-8000-000000000002' };
    const catalog = [food(eaten, 'Skyr')];

    const day = withMeal(withMeal(emptyDay('2026-09-13'), first, catalog), second, catalog);

    expect(day.foods).toHaveLength(1);
  });
});

describe('withoutMeal', () => {
  it('takes the meal off the day and recounts what is left', () => {
    const kept = meal('green');
    const removed = { ...meal('orange', 'orange'), id: '01930000-0000-7000-8000-000000000002' };
    const day = withMeal(withMeal(emptyDay('2026-09-13'), kept, []), removed, []);

    const after = withoutMeal(day, removed.id);

    expect(after.meals.map((entry) => entry.id)).toEqual([kept.id]);
    expect(after.colourCounts).toEqual({ green: 1, yellow: 0, orange: 0, unclassified: 0 });
  });

  it('leaves a day alone when the meal is not on it', () => {
    const day = withMeal(emptyDay('2026-09-13'), meal('green'), []);

    expect(withoutMeal(day, 'nothing-like-this').meals).toHaveLength(1);
  });
});

describe('withClassification', () => {
  it('colours every item naming the food, and the summary with them', () => {
    const eaten = meal(null, null);
    const foodId = eaten.entries[0]?.foodId ?? '';
    const day = withMeal(emptyDay('2026-09-13'), eaten, [
      { ...food(foodId, 'Mystery item'), category: null },
    ]);

    const after = withClassification(day, foodId, 'orange');

    expect(after.meals[0]?.entries.map((entry) => entry.category)).toEqual(['orange', null]);
    expect(after.colourCounts).toEqual({ green: 0, yellow: 0, orange: 1, unclassified: 1 });
    expect(after.foods[0]?.category).toBe('orange');
  });

  it('leaves an entry that already carries a colour exactly as it is', () => {
    const eaten = meal('green');
    const foodId = eaten.entries[0]?.foodId ?? '';
    const day = withMeal(emptyDay('2026-09-13'), eaten, [food(foodId, 'Already judged')]);

    const after = withClassification(day, foodId, 'orange');

    expect(after.meals[0]?.entries.map((entry) => entry.category)).toEqual(['green']);
    expect(after.colourCounts).toEqual({ green: 1, yellow: 0, orange: 0, unclassified: 0 });
  });
});

describe("the week's counts", () => {
  function dayInAWeek(): ReturnType<typeof emptyDay> {
    const day = emptyDay('2026-09-16');

    return {
      ...day,
      budget: {
        green: { limit: null, count: 5, remaining: null },
        yellow: { limit: 12, count: 7, remaining: 5 },
        orange: { limit: 4, count: 3, remaining: 1 },
        unclassified: 2,
      },
    };
  }

  it('adds a logged meal to the week as well as to the day', () => {
    const after = withMeal(dayInAWeek(), meal('orange', 'green'), []);

    expect(after.budget.orange).toEqual({ limit: 4, count: 4, remaining: 0 });
    expect(after.budget.green).toEqual({ limit: null, count: 6, remaining: null });
    expect(after.colourCounts.orange).toBe(1);
  });

  it('counts an edited meal once rather than twice', () => {
    const first = meal('orange');
    const logged = withMeal(dayInAWeek(), first, []);

    const edited = withMeal(logged, { ...first, entries: meal('orange', 'orange').entries }, []);

    expect(edited.budget.orange.count).toBe(5);
  });

  it('takes a deleted meal back out of the week', () => {
    const eaten = meal('yellow', 'yellow');
    const logged = withMeal(dayInAWeek(), eaten, []);

    const after = withoutMeal(logged, eaten.id);

    expect(after.budget.yellow).toEqual({ limit: 12, count: 7, remaining: 5 });
  });

  it('lets the week go past a limit rather than stopping at it', () => {
    const after = withMeal(dayInAWeek(), meal('orange', 'orange', 'orange'), []);

    expect(after.budget.orange).toEqual({ limit: 4, count: 6, remaining: -2 });
  });

  it('moves a colour out of unclassified when the food behind it is judged', () => {
    const eaten = meal(null);
    const foodId = eaten.entries[0]?.foodId ?? '';
    const logged = withMeal(dayInAWeek(), eaten, []);
    expect(logged.budget.unclassified).toBe(3);

    const after = withClassification(logged, foodId, 'green');

    expect(after.budget.unclassified).toBe(2);
    expect(after.budget.green.count).toBe(6);
  });
});

describe('shiftDate', () => {
  it('moves whole calendar days, across a month and a year boundary', () => {
    expect(shiftDate('2026-09-13', -1)).toBe('2026-09-12');
    expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDate('2025-12-31', 1)).toBe('2026-01-01');
  });

  it('is unmoved by a daylight saving transition, since the date carries no zone', () => {
    expect(shiftDate('2026-03-28', 1)).toBe('2026-03-29');
    expect(shiftDate('2026-03-29', 1)).toBe('2026-03-30');
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

describe('withoutWeight', () => {
  it('takes the reading off the day, the empty state removing one falls back to', () => {
    const entry = {
      id: '01930000-0000-7000-8000-000000000003',
      userId: '01930000-0000-7000-8000-0000000000ff',
      weightKg: 81.4,
      localDate: '2026-09-13',
      recordedAt: '2026-09-13T06:00:00.000Z',
    };

    const day = withoutWeight(withWeight(emptyDay('2026-09-13'), entry));

    expect(day.weightEntry).toBeNull();
  });
});
