import {
  MEAL_TYPES,
  type Locale,
  type LocalDate,
  type MealResponse,
  type MealType,
  type Timezone,
} from '@portionium/schemas';

import { CACHED_DAYS, shiftDate } from './db';
import { translate, type TranslationKey } from './i18n';

const TYPE_RANK = new Map(MEAL_TYPES.map((type, rank) => [type, rank]));

export function orderMeals(meals: readonly MealResponse[]): MealResponse[] {
  return [...meals].sort(
    (left, right) =>
      (TYPE_RANK.get(left.type) ?? 0) - (TYPE_RANK.get(right.type) ?? 0) ||
      left.loggedAt.localeCompare(right.loggedAt),
  );
}

const MEAL_TYPE_KEYS: Record<MealType, TranslationKey> = {
  breakfast: 'mealTypeBreakfast',
  lunch: 'mealTypeLunch',
  dinner: 'mealTypeDinner',
  snack: 'mealTypeSnack',
};

export function mealTypeLabel(type: MealType, locale: Locale): string {
  return translate(locale, MEAL_TYPE_KEYS[type]);
}

export function mealTypeAt(instant: Date, timezone: Timezone): MealType {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);

  // By name rather than by position: a formatted hour can carry a separator or a marker.
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);

  if (hour >= 5 && hour < 11) {
    return 'breakfast';
  }

  if (hour >= 11 && hour < 15) {
    return 'lunch';
  }

  return hour >= 17 && hour < 22 ? 'dinner' : 'snack';
}

export function pageTo(date: LocalDate, days: number, today: LocalDate): LocalDate {
  const moved = shiftDate(date, days);
  const earliest = shiftDate(today, -(CACHED_DAYS - 1));

  if (moved > today) {
    return today;
  }

  return moved < earliest ? earliest : moved;
}

export function dayLabel(date: LocalDate, today: LocalDate, locale: Locale): string {
  if (date === today) {
    return translate(locale, 'dayToday');
  }

  if (date === shiftDate(today, -1)) {
    return translate(locale, 'dayYesterday');
  }

  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(`${date}T00:00:00Z`));
}
