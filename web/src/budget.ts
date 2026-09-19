import {
  CATEGORIES,
  type Category,
  type Locale,
  type WeeklyBudgetStatus,
} from '@portionium/schemas';

import { categoryLabelIn } from './dot';
import { translate } from './i18n';

/**
 * The arithmetic and the wording behind the weekly allowance row, split out of ./today.tsx for
 * the reason ./day.ts and ./stats.ts are: none of it needs React, a DOM or IndexedDB, so all of
 * it can be tested as plain functions.
 *
 * Nothing here computes a count. The server counts the week and stamps the limit beside it, see
 * the budget field on dayResponseSchema, and this file only decides what of that is worth
 * putting on screen and how it is said out loud. A second count on this side would be a second
 * answer to one question, the mistake ./food-search.ts already refuses to make about ranking.
 */

/** One category on the row: what was eaten, what was asked for, and whether the two have met. */
export interface BudgetPosition {
  category: Category;
  count: number;
  /** Null is unlimited, and the row then shows the count alone rather than a denominator. */
  limit: number | null;
  /**
   * At or past the allowance. A fact rather than a verdict: it earns a slightly heavier weight
   * on the numbers and nothing else, no colour of its own, no icon and no capital letters. The
   * numbers already say it, see the copy guidance on this story.
   */
  atLimit: boolean;
}

/**
 * Whether this account has expressed any intention at all.
 *
 * The row is hidden outright when it has not, which is what keeps the default experience exactly
 * as it was before any of this existed. Zero is an intention and counts here; null is the
 * absence of one, see weeklyBudgetLimitSchema.
 */
export function hasAnyLimit(budget: WeeklyBudgetStatus): boolean {
  return CATEGORIES.some((category) => budget[category].limit !== null);
}

/** The three categories in the order the traffic light reads, whatever the response's key order. */
export function budgetPositions(budget: WeeklyBudgetStatus): BudgetPosition[] {
  return CATEGORIES.map((category) => {
    const { count, limit } = budget[category];

    return { category, count, limit, atLimit: limit !== null && count >= limit };
  });
}

/**
 * The whole row as one sentence, which is what a screen reader is given and the only channel
 * that does not depend on telling this palette's green from its orange.
 *
 * Each category is named in words here rather than abbreviated, so the position is legible
 * without the dots. Phrased as a position and never as a verdict: "7 of 12" and, at the limit,
 * "12 of 12", which says the same thing the emphasis does without a word like "exceeded"
 * appearing anywhere. A category with no limit contributes its bare count.
 */
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
