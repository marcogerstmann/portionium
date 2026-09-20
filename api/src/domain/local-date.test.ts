import { DEFAULT_DAY_BOUNDARY_HOUR, type LocalDate } from '@portionium/schemas';
import { describe, expect, it } from 'vitest';

import { resolveLocalDate } from './local-date.js';

const BERLIN = 'Europe/Berlin';
const AUCKLAND = 'Pacific/Auckland';

const at = (instant: string) => new Date(instant);

describe('resolveLocalDate', () => {
  it('uses the calendar day in the user timezone, not the one in UTC', () => {
    const instant = at('2026-06-15T20:00:00.000Z');

    expect(resolveLocalDate(instant, BERLIN, DEFAULT_DAY_BOUNDARY_HOUR)).toBe('2026-06-15');
    expect(resolveLocalDate(instant, AUCKLAND, DEFAULT_DAY_BOUNDARY_HOUR)).toBe('2026-06-16');
  });

  it('handles a zone whose offset is not a whole number of hours', () => {
    expect(resolveLocalDate(at('2026-06-16T18:15:00.000Z'), 'Asia/Kolkata', 4)).toBe('2026-06-16');
  });

  describe('the day boundary', () => {
    it('puts an instant before the boundary on the previous day', () => {
      expect(resolveLocalDate(at('2026-06-16T01:59:00.000Z'), BERLIN, 4)).toBe('2026-06-15');
    });

    it('puts an instant at the boundary on the new day', () => {
      expect(resolveLocalDate(at('2026-06-16T02:00:00.000Z'), BERLIN, 4)).toBe('2026-06-16');
    });

    it('is configurable, so a later boundary moves the same instant back a day', () => {
      const instant = at('2026-06-16T03:00:00.000Z');

      expect(resolveLocalDate(instant, BERLIN, 4)).toBe('2026-06-16');
      expect(resolveLocalDate(instant, BERLIN, 6)).toBe('2026-06-15');
    });

    it('falls back to plain midnight when a user sets it to zero', () => {
      expect(resolveLocalDate(at('2026-06-15T22:30:00.000Z'), BERLIN, 0)).toBe('2026-06-16');
    });

    it('rolls back across a month end, and across a leap day', () => {
      expect(resolveLocalDate(at('2028-02-29T23:30:00.000Z'), BERLIN, 4)).toBe('2028-02-29');
      expect(resolveLocalDate(at('2026-02-28T23:30:00.000Z'), BERLIN, 4)).toBe('2026-02-28');
    });
  });

  describe('daylight saving transitions', () => {
    it('tracks the boundary through a spring forward', () => {
      expect(resolveLocalDate(at('2026-03-28T03:00:00.000Z'), BERLIN, 4)).toBe('2026-03-28');
      expect(resolveLocalDate(at('2026-03-29T01:59:00.000Z'), BERLIN, 4)).toBe('2026-03-28');
      expect(resolveLocalDate(at('2026-03-29T02:00:00.000Z'), BERLIN, 4)).toBe('2026-03-29');
    });

    it('copes with a boundary hour that the spring forward skips entirely', () => {
      // 02:00 never happens on 2026-03-29 in Berlin. The hour is compared and never constructed, so
      // a user whose day starts then still gets a clean split.
      expect(resolveLocalDate(at('2026-03-29T00:59:00.000Z'), BERLIN, 2)).toBe('2026-03-28');
      expect(resolveLocalDate(at('2026-03-29T01:00:00.000Z'), BERLIN, 2)).toBe('2026-03-29');
    });

    it('tracks the boundary through an autumn fall back', () => {
      expect(resolveLocalDate(at('2026-10-24T02:00:00.000Z'), BERLIN, 4)).toBe('2026-10-24');
      expect(resolveLocalDate(at('2026-10-25T02:59:00.000Z'), BERLIN, 4)).toBe('2026-10-24');
      expect(resolveLocalDate(at('2026-10-25T03:00:00.000Z'), BERLIN, 4)).toBe('2026-10-25');
    });

    it('is untroubled by the hour the fall back repeats', () => {
      expect(resolveLocalDate(at('2026-10-25T00:30:00.000Z'), BERLIN, 4)).toBe('2026-10-24');
      expect(resolveLocalDate(at('2026-10-25T01:30:00.000Z'), BERLIN, 4)).toBe('2026-10-24');
    });

    it('applies the southern hemisphere transition on the southern hemisphere date', () => {
      expect(resolveLocalDate(at('2026-09-25T16:00:00.000Z'), AUCKLAND, 4)).toBe('2026-09-26');
      expect(resolveLocalDate(at('2026-09-27T14:59:00.000Z'), AUCKLAND, 4)).toBe('2026-09-27');
      expect(resolveLocalDate(at('2026-09-27T15:00:00.000Z'), AUCKLAND, 4)).toBe('2026-09-28');
    });
  });

  describe('a user who changes timezone', () => {
    it('stamps later rows in the new zone and leaves earlier ones alone', () => {
      const beforeTheMove = at('2026-06-15T20:00:00.000Z');
      const afterTheMove = at('2026-06-20T20:00:00.000Z');

      const stamped: LocalDate[] = [resolveLocalDate(beforeTheMove, BERLIN, 4)];
      stamped.push(resolveLocalDate(afterTheMove, AUCKLAND, 4));

      expect(stamped).toEqual(['2026-06-15', '2026-06-21']);

      expect(resolveLocalDate(beforeTheMove, AUCKLAND, 4)).toBe('2026-06-16');
      expect(stamped[0]).toBe('2026-06-15');
    });
  });
});
