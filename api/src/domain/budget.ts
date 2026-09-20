import type { BudgetCategoryStatus, WeeklyBudgets, WeeklyBudgetStatus } from '@portionium/schemas';

import { countColours, type DateRangeEntry } from './stats.js';

/**
 * `remaining` may go negative: the size of the overshoot is the only interesting number once
 * somebody is past their allowance.
 */
function statusFor(limit: number | null, count: number): BudgetCategoryStatus {
  return { limit, count, remaining: limit === null ? null : limit - count };
}

export function computeBudgetStatus(
  entries: readonly Pick<DateRangeEntry, 'category'>[],
  budgets: WeeklyBudgets,
): WeeklyBudgetStatus {
  const counts = countColours(entries);

  return {
    green: statusFor(budgets.green, counts.green),
    yellow: statusFor(budgets.yellow, counts.yellow),
    orange: statusFor(budgets.orange, counts.orange),
    unclassified: counts.unclassified,
  };
}
