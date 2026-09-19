import type { BudgetCategoryStatus, WeeklyBudgets, WeeklyBudgetStatus } from '@portionium/schemas';

import { countColours, type DateRangeEntry } from './stats.js';

/**
 * Where a week stands against the allowance somebody set themselves.
 *
 * A soft lock, which is the whole design. Nothing in this file decides anything, refuses
 * anything or names a verdict. It counts what was logged, subtracts the limit, and hands back
 * numbers; whether eleven of twelve is reassuring or alarming is the reader's business and the
 * client's phrasing. There is deliberately no `exceeded` boolean here for a route to pass on.
 *
 * It is also stateless with respect to time: the limits it is called with are whatever is
 * configured right now, so a limit changed mid week takes effect for the current week on the
 * next read, with nothing to recompute and no materialised row to invalidate. The same property
 * is what makes a past week evaluated against today's limits, see statsBudgetResponseSchema.
 */

/**
 * One category. `remaining` is `limit - count` and is allowed to go negative, because the size
 * of the overshoot is the only interesting number once somebody is past their allowance and
 * clamping it at zero throws exactly that away.
 *
 * A null limit gives a null remaining and never a stand-in ceiling. There is nothing to be
 * remaining against, and a made up large number is one a client would draw a progress bar
 * against and a statistic would later average.
 */
function statusFor(limit: number | null, count: number): BudgetCategoryStatus {
  return { limit, count, remaining: limit === null ? null : limit - count };
}

/**
 * `entries` is expected to already be the ones logged inside the week, which is what the
 * `local_date` range on findEntriesForDateRange returns. This function does no date filtering
 * of its own: the week's bounds come from isoWeekOf and are applied in SQL, so there is one
 * place a week is defined and it is not this one.
 *
 * Unclassified entries are counted and charged to nothing. They have no colour to spend, and
 * assigning them one would make confirming a food in the review queue quietly move a number
 * that is supposed to be about what was eaten.
 */
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
