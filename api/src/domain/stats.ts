import type { Category, ColourCounts, LocalDate } from '@portionium/schemas';

/**
 * POR-36: how a range of days looked, one colour breakdown per local date. Grouped by the
 * `local_date` every meal is already stamped with, the same column every other summary in this
 * codebase groups by, see the comment on meal.ts's local_date.
 *
 * Nothing here is materialised. `findItemsForDateRange` in db/meal.ts is one query for the whole
 * range, and this file groups and resolves the colours over whatever it returns, the same split
 * `itemsAndColours` in http/routes/meals.ts makes for a single day. A year of one account's
 * items is a few thousand rows and grouping them in memory on every call is cheap. If this ever
 * has to serve a dashboard across many accounts at once, or a range that routinely runs past a
 * year, the fix is a per-day colour count table kept in step by triggers the way food_search is,
 * not a wider query here.
 */

/** The shape findItemsForDateRange returns: enough to bucket an item by day and resolve its colour. */
export interface DateRangeItem {
  foodId: string;
  localDate: LocalDate;
}

/** Every local date from `from` to `to`, inclusive. Plain calendar arithmetic: a LocalDate is
 * already zoneless (see localDateSchema), so unlike resolveLocalDate this needs no timezone. */
export function everyLocalDate(from: LocalDate, to: LocalDate): LocalDate[] {
  const dates: LocalDate[] = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 86_400_000) {
    dates.push(new Date(t).toISOString().slice(0, 10));
  }

  return dates;
}

const ZERO_COUNTS: ColourCounts = { green: 0, yellow: 0, orange: 0, unclassified: 0 };

/** Each count as a fraction of the total, 0 across the board when nothing was logged rather than
 * a division by zero. Exported for POR-38's weekly summary, which sums a week's days into the
 * same shape and wants the same share math over the total rather than a second copy of it. */
export function shareOf(counts: ColourCounts): ColourCounts {
  const total = counts.green + counts.yellow + counts.orange + counts.unclassified;
  if (total === 0) {
    return ZERO_COUNTS;
  }

  return {
    green: counts.green / total,
    yellow: counts.yellow / total,
    orange: counts.orange / total,
    unclassified: counts.unclassified / total,
  };
}

export interface DailyColourStats {
  date: LocalDate;
  counts: ColourCounts;
  share: ColourCounts;
}

/**
 * One entry per day in `[from, to]`, oldest first, whether or not anything was logged on it.
 * Missing days are what `everyLocalDate` supplies: the loop over `items` only ever fills a
 * bucket that already exists, so a day with nothing logged surfaces as zero counts rather than
 * being left out for a client to notice and fill in itself.
 *
 * `resolved` is keyed by food id, the same map `resolveClassifications` returns, so a food with
 * no verdict simply has no entry and falls through to `unclassified` below, never counted as any
 * colour by construction.
 */
export function computeDailyColourStats(
  items: readonly DateRangeItem[],
  resolved: ReadonlyMap<string, { category: Category }>,
  from: LocalDate,
  to: LocalDate,
): DailyColourStats[] {
  const byDate = new Map<LocalDate, ColourCounts>();
  for (const date of everyLocalDate(from, to)) {
    byDate.set(date, { ...ZERO_COUNTS });
  }

  for (const item of items) {
    const counts = byDate.get(item.localDate);
    // Not reachable while the caller filters items by the same [from, to] it passes here, kept
    // as a guard rather than an assertion so a mismatched caller loses an item instead of
    // crashing the request.
    if (counts === undefined) {
      continue;
    }

    const category = resolved.get(item.foodId)?.category ?? 'unclassified';
    counts[category] += 1;
  }

  return [...byDate.entries()].map(([date, counts]) => ({ date, counts, share: shareOf(counts) }));
}
