import { Temporal } from '@js-temporal/polyfill';
import type { LocalDate, Timezone } from '@portionium/schemas';

/**
 * The one place a UTC instant becomes a user's calendar day. Every `local_date` written
 * anywhere comes from here, see docs/adr/002-local-day-boundaries.md for why the conversion
 * happens at write time and never on read, and why it is done with Temporal.
 *
 * Two things make this less obvious than it looks. A day does not start at midnight, it starts
 * at the user's boundary hour, so a meal at 01:00 belongs to the evening before. And an offset
 * is not a property of a timezone, it is a property of an instant in a timezone, so it cannot
 * be looked up once and reused.
 *
 * The polyfill is temporary. Temporal is unflagged from Node 26, which reaches LTS on
 * 2026-10-28, and at that point the import above is deleted and `ESNext.Temporal` is added to
 * `lib` in tsconfig.base.json. Nothing below this line changes, it is the same API either way.
 */

/**
 * The calendar day an instant belongs to, for one user.
 *
 * `toZonedDateTimeISO` is the only step that involves a timezone. It resolves whichever offset
 * was in force at that instant, so the boundary comparison below is against a real wall clock
 * hour and never against an assumed offset, which is the thing that breaks across a DST
 * transition. Subtracting a day is then calendar arithmetic on a zoneless date, so a 23 hour
 * or 25 hour day cannot leak into it.
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
  const local = Temporal.Instant.fromEpochMilliseconds(instant.getTime()).toZonedDateTimeISO(
    timezone,
  );

  const date = local.toPlainDate();

  return (local.hour >= boundaryHour ? date : date.subtract({ days: 1 })).toString();
}
