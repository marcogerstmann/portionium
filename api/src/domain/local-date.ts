import type { LocalDate, Timezone } from '@portionium/schemas';

/**
 * The one place a UTC instant becomes a user's calendar day. Every `local_date` written
 * anywhere comes from here, see docs/adr/002-local-day-boundaries.md for why the conversion
 * happens at write time and never on read.
 *
 * Two things make this less obvious than it looks. A day does not start at midnight, it starts
 * at the user's boundary hour, so a meal at 01:00 belongs to the evening before. And an offset
 * is not a property of a timezone, it is a property of an instant in a timezone, so it cannot
 * be looked up once and reused.
 */

/**
 * Wall clock fields for an instant in a zone, from the runtime's IANA database.
 *
 * `en-CA` renders as `YYYY-MM-DD`, and `hourCycle: 'h23'` puts midnight at `00` rather than at
 * `24`, which is what the same request in some other locales would give back. Neither choice is
 * user visible, the parts are read by name and the locale never reaches a screen.
 *
 * This is the only step that involves a timezone at all. ICU has already applied whichever
 * offset was in force at that instant by the time these parts exist, so nothing below has to
 * know that DST is a thing.
 */
const formatters = new Map<Timezone, Intl.DateTimeFormat>();

function wallClockIn(instant: Date, timezone: Timezone): { date: LocalDate; hour: number } {
  let formatter = formatters.get(timezone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timezone, formatter);
  }

  const parts = new Map(formatter.formatToParts(instant).map(({ type, value }) => [type, value]));

  return {
    date: `${parts.get('year')}-${parts.get('month')}-${parts.get('day')}`,
    hour: Number(parts.get('hour')),
  };
}

/**
 * The calendar day before a plain date.
 *
 * This is arithmetic on a zoneless `YYYY-MM-DD`, not a conversion. `Date.parse` reads a date
 * only string as UTC midnight and `toISOString` writes UTC back out, so no offset is consulted
 * in either direction and there is no DST here to get wrong. A UTC day is always exactly 24
 * hours, which is what makes the subtraction safe, and it is done this way rather than by hand
 * because it already knows that the day before the 1st of March is the 28th in most years and
 * the 29th in some.
 */
function previousDay(date: LocalDate): LocalDate {
  return new Date(Date.parse(date) - 86_400_000).toISOString().slice(0, 10);
}

/**
 * The calendar day an instant belongs to, for one user.
 *
 * `boundaryHour` is required rather than defaulted. The default is a property of the user, it
 * lives on the column (see db/schema/user.ts), and a caller that has not loaded the user's
 * setting should not silently get somebody else's day boundary.
 */
export function resolveLocalDate(
  instant: Date,
  timezone: Timezone,
  boundaryHour: number,
): LocalDate {
  const { date, hour } = wallClockIn(instant, timezone);

  return hour >= boundaryHour ? date : previousDay(date);
}
