import type { Category, ColourCounts, LocalDate } from '@portionium/schemas';

export interface DateRangeEntry {
  category: Category | null;
  localDate: LocalDate;
}

export function everyLocalDate(from: LocalDate, to: LocalDate): LocalDate[] {
  const dates: LocalDate[] = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 86_400_000) {
    dates.push(new Date(t).toISOString().slice(0, 10));
  }

  return dates;
}

const ZERO_COUNTS: ColourCounts = { green: 0, yellow: 0, orange: 0, unclassified: 0 };

export function countColours(entries: readonly Pick<DateRangeEntry, 'category'>[]): ColourCounts {
  const counts: ColourCounts = { ...ZERO_COUNTS };
  for (const entry of entries) {
    counts[entry.category ?? 'unclassified'] += 1;
  }

  return counts;
}

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
    // Unreachable while the caller filters by the same range; a guard rather than an assertion, so
    // a mismatched caller loses an entry instead of failing the request.
    if (counts === undefined) {
      continue;
    }

    counts[entry.category ?? 'unclassified'] += 1;
  }

  return [...byDate.entries()].map(([date, counts]) => ({ date, counts, share: shareOf(counts) }));
}
