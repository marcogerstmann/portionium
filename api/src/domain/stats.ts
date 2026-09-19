import type { Category, ColourCounts, LocalDate } from '@portionium/schemas';

/**
 * POR-36: how a range of days looked, one colour breakdown per local date. Grouped by the
 * `local_date` every meal is already stamped with, the same column every other summary in this
 * codebase groups by, see the comment on meal.ts's local_date.
 *
 * Nothing here is materialised, and nothing here is resolved either. An entry carries the colour
 * it was logged with, see docs/adr/011-an-entry-is-a-colour.md, so `findEntriesForDateRange` in
 * db/meal.ts is one query for the whole range and this file only has to bucket what it returns.
 * A year of one account's entries is a few thousand rows and grouping them in memory on every
 * call is cheap. If this ever has to serve a dashboard across many accounts at once, or a range
 * that routinely runs past a year, the fix is a per-day colour count table kept in step by
 * triggers the way food_search is, not a wider query here.
 */

/** The shape findEntriesForDateRange returns: enough to bucket an entry by day and count it. */
export interface DateRangeEntry {
  category: Category | null;
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

/**
 * How many entries landed in each colour. The one definition of that tally: GET /days/{date}
 * counts a day with it and the weekly budget counts a week with it, so the day's summary bar and
 * the week's allowance can never be counting slightly different things.
 *
 * A null `category` is an entry whose food nobody has judged yet. It is counted as
 * `unclassified` rather than dropped or charged to a colour, which is what keeps a week that
 * looks disciplined because half of it is grey distinguishable from one that is.
 */
export function countColours(entries: readonly Pick<DateRangeEntry, 'category'>[]): ColourCounts {
  const counts: ColourCounts = { ...ZERO_COUNTS };
  for (const entry of entries) {
    counts[entry.category ?? 'unclassified'] += 1;
  }

  return counts;
}

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
 * One row per day in `[from, to]`, oldest first, whether or not anything was logged on it.
 * Missing days are what `everyLocalDate` supplies: the loop over `entries` only ever fills a
 * bucket that already exists, so a day with nothing logged surfaces as zero counts rather than
 * being left out for a client to notice and fill in itself.
 *
 * A null `category` is an entry whose food nobody has judged yet and is counted as
 * `unclassified`, which is the same thing the day endpoint does with it.
 */
export function computeDailyColourStats(
  entries: readonly DateRangeEntry[],
  from: LocalDate,
  to: LocalDate,
): DailyColourStats[] {
  const byDate = new Map<LocalDate, ColourCounts>();
  for (const date of everyLocalDate(from, to)) {
    byDate.set(date, { ...ZERO_COUNTS });
  }

  for (const entry of entries) {
    const counts = byDate.get(entry.localDate);
    // Not reachable while the caller filters entries by the same [from, to] it passes here, kept
    // as a guard rather than an assertion so a mismatched caller loses an entry instead of
    // crashing the request.
    if (counts === undefined) {
      continue;
    }

    counts[entry.category ?? 'unclassified'] += 1;
  }

  return [...byDate.entries()].map(([date, counts]) => ({ date, counts, share: shareOf(counts) }));
}
