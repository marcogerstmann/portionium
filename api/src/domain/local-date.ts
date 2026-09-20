import { Temporal } from '@js-temporal/polyfill';
import type { LocalDate, Timezone } from '@portionium/schemas';

/**
 * The one place a UTC instant becomes a user's calendar day. See
 * docs/adr/002-local-day-boundaries.md.
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
