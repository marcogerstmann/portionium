import { DEFAULT_DAY_BOUNDARY_HOUR, type LocalDate } from '@portionium/schemas';
import { describe, expect, it } from 'vitest';

import { resolveLocalDate } from './local-date.js';

const BERLIN = 'Europe/Berlin';
const AUCKLAND = 'Pacific/Auckland';

/** The instants below are all UTC, which is the only form a stored timestamp ever takes. */
const at = (instant: string) => new Date(instant);

describe('resolveLocalDate', () => {
  it('uses the calendar day in the user timezone, not the one in UTC', () => {
    // Same instant, one evening in Berlin and the following morning in Auckland.
    const instant = at('2026-06-15T20:00:00.000Z');

    expect(resolveLocalDate(instant, BERLIN, DEFAULT_DAY_BOUNDARY_HOUR)).toBe('2026-06-15');
    expect(resolveLocalDate(instant, AUCKLAND, DEFAULT_DAY_BOUNDARY_HOUR)).toBe('2026-06-16');
  });

  it('handles a zone whose offset is not a whole number of hours', () => {
    // 23:45 in Kolkata, so still the 15th there while it is already the 16th in UTC.
    expect(resolveLocalDate(at('2026-06-16T18:15:00.000Z'), 'Asia/Kolkata', 4)).toBe('2026-06-16');
  });

  describe('the day boundary', () => {
    it('puts an instant before the boundary on the previous day', () => {
      // 03:59 in Berlin, which the user would call "last night".
      expect(resolveLocalDate(at('2026-06-16T01:59:00.000Z'), BERLIN, 4)).toBe('2026-06-15');
    });

    it('puts an instant at the boundary on the new day', () => {
      // 04:00 in Berlin, one minute later.
      expect(resolveLocalDate(at('2026-06-16T02:00:00.000Z'), BERLIN, 4)).toBe('2026-06-16');
    });

    it('is configurable, so a later boundary moves the same instant back a day', () => {
      const instant = at('2026-06-16T03:00:00.000Z'); // 05:00 in Berlin.

      expect(resolveLocalDate(instant, BERLIN, 4)).toBe('2026-06-16');
      expect(resolveLocalDate(instant, BERLIN, 6)).toBe('2026-06-15');
    });

    it('falls back to plain midnight when a user sets it to zero', () => {
      expect(resolveLocalDate(at('2026-06-15T22:30:00.000Z'), BERLIN, 0)).toBe('2026-06-16');
    });

    it('rolls back across a month end, and across a leap day', () => {
      // 00:30 on the 1st of March in Berlin, so it belongs to the 29th of February.
      expect(resolveLocalDate(at('2028-02-29T23:30:00.000Z'), BERLIN, 4)).toBe('2028-02-29');
      expect(resolveLocalDate(at('2026-02-28T23:30:00.000Z'), BERLIN, 4)).toBe('2026-02-28');
    });
  });

  describe('daylight saving transitions', () => {
    /**
     * Berlin springs forward on 2026-03-29, 02:00 CET becomes 03:00 CEST. The day therefore
     * has 23 hours and its 04:00 boundary arrives an hour earlier in UTC than the day before.
     * An implementation that reads one offset and reuses it gets exactly one of these two wrong.
     */
    it('tracks the boundary through a spring forward', () => {
      expect(resolveLocalDate(at('2026-03-28T03:00:00.000Z'), BERLIN, 4)).toBe('2026-03-28');
      expect(resolveLocalDate(at('2026-03-29T01:59:00.000Z'), BERLIN, 4)).toBe('2026-03-28');
      expect(resolveLocalDate(at('2026-03-29T02:00:00.000Z'), BERLIN, 4)).toBe('2026-03-29');
    });

    it('copes with a boundary hour that the spring forward skips entirely', () => {
      // 02:00 never happens on 2026-03-29 in Berlin. A user whose day starts then still gets a
      // clean split, because the hour is compared and never constructed.
      expect(resolveLocalDate(at('2026-03-29T00:59:00.000Z'), BERLIN, 2)).toBe('2026-03-28');
      expect(resolveLocalDate(at('2026-03-29T01:00:00.000Z'), BERLIN, 2)).toBe('2026-03-29');
    });

    /**
     * Berlin falls back on 2026-10-25, 03:00 CEST becomes 02:00 CET, so the day has 25 hours
     * and the wall clock reads 02:30 twice.
     */
    it('tracks the boundary through an autumn fall back', () => {
      expect(resolveLocalDate(at('2026-10-24T02:00:00.000Z'), BERLIN, 4)).toBe('2026-10-24');
      expect(resolveLocalDate(at('2026-10-25T02:59:00.000Z'), BERLIN, 4)).toBe('2026-10-24');
      expect(resolveLocalDate(at('2026-10-25T03:00:00.000Z'), BERLIN, 4)).toBe('2026-10-25');
    });

    it('is untroubled by the hour the fall back repeats', () => {
      // Two distinct instants, both 02:30 local. Ambiguity only bites when going the other way,
      // from a wall clock to an instant, which this function never does.
      expect(resolveLocalDate(at('2026-10-25T00:30:00.000Z'), BERLIN, 4)).toBe('2026-10-24');
      expect(resolveLocalDate(at('2026-10-25T01:30:00.000Z'), BERLIN, 4)).toBe('2026-10-24');
    });

    it('applies the southern hemisphere transition on the southern hemisphere date', () => {
      // Auckland goes the other way round the year, forward on 2026-09-27. Its boundary sits
      // at 16:00 UTC the day before the transition and at 15:00 UTC after it.
      expect(resolveLocalDate(at('2026-09-25T16:00:00.000Z'), AUCKLAND, 4)).toBe('2026-09-26');
      expect(resolveLocalDate(at('2026-09-27T14:59:00.000Z'), AUCKLAND, 4)).toBe('2026-09-27');
      expect(resolveLocalDate(at('2026-09-27T15:00:00.000Z'), AUCKLAND, 4)).toBe('2026-09-28');
    });
  });

  describe('a user who changes timezone', () => {
    /**
     * The stamped date is a value written once, not a view. Moving the user changes what the
     * next write resolves to and leaves every earlier row exactly as it was, which is the
     * decision recorded in docs/adr/002-local-day-boundaries.md rather than an oversight.
     */
    it('stamps later rows in the new zone and leaves earlier ones alone', () => {
      const beforeTheMove = at('2026-06-15T20:00:00.000Z');
      const afterTheMove = at('2026-06-20T20:00:00.000Z');

      const stamped: LocalDate[] = [resolveLocalDate(beforeTheMove, BERLIN, 4)];
      stamped.push(resolveLocalDate(afterTheMove, AUCKLAND, 4));

      expect(stamped).toEqual(['2026-06-15', '2026-06-21']);

      // Re-resolving the older instant in the new zone would move it a day, which is precisely
      // what no migration and no read path is allowed to do.
      expect(resolveLocalDate(beforeTheMove, AUCKLAND, 4)).toBe('2026-06-16');
      expect(stamped[0]).toBe('2026-06-15');
    });
  });
});
