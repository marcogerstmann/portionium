import {
  CATEGORIES,
  type Category,
  type Locale,
  type WeeklyBudgetStatus,
} from '@portionium/schemas';

import { categoryLabelIn } from './dot';
import { translate } from './i18n';

export interface BudgetPosition {
  category: Category;
  count: number;
  limit: number | null;
  atLimit: boolean;
}

export function hasAnyLimit(budget: WeeklyBudgetStatus): boolean {
  return CATEGORIES.some((category) => budget[category].limit !== null);
}

export function budgetPositions(budget: WeeklyBudgetStatus): BudgetPosition[] {
  return CATEGORIES.map((category) => {
    const { count, limit } = budget[category];

    return { category, count, limit, atLimit: limit !== null && count >= limit };
  });
}

export function spokenBudget(budget: WeeklyBudgetStatus, locale: Locale): string {
  const positions = budgetPositions(budget)
    .map(({ category, count, limit }) => {
      const label = categoryLabelIn(category, locale);

      return limit === null
        ? translate(locale, 'budgetSpokenCount', { count, label })
        : translate(locale, 'budgetSpokenOfLimit', { count, limit, label });
    })
    .join(', ');

  return translate(locale, 'budgetSpokenWeek', { positions });
}
