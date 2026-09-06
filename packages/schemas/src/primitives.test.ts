import { describe, expect, it } from 'vitest';

import {
  categorySchema,
  classificationSourceSchema,
  foodKindSchema,
  idSchema,
  localDateSchema,
  mealTypeSchema,
  timestampSchema,
  timezoneSchema,
  weightGramsSchema,
} from './primitives.js';

describe('idSchema', () => {
  it('accepts a UUIDv7', () => {
    expect(idSchema.safeParse('0199e0e9-1c4b-7000-8f2c-6e4c1c2a9b31').success).toBe(true);
  });

  it('rejects a UUIDv4, the version nibble is part of the contract', () => {
    expect(idSchema.safeParse('0199e0e9-1c4b-4000-8f2c-6e4c1c2a9b31').success).toBe(false);
  });

  it('rejects anything that is not a UUID', () => {
    expect(idSchema.safeParse('nope').success).toBe(false);
  });
});

describe('localDateSchema', () => {
  it('accepts YYYY-MM-DD', () => {
    expect(localDateSchema.safeParse('2026-09-06').success).toBe(true);
  });

  it('accepts the 29th of February in a leap year', () => {
    expect(localDateSchema.safeParse('2024-02-29').success).toBe(true);
  });

  it('rejects a day the month does not have', () => {
    expect(localDateSchema.safeParse('2026-02-30').success).toBe(false);
    expect(localDateSchema.safeParse('2026-04-31').success).toBe(false);
  });

  it('rejects anything carrying a time or a zone, a local date is neither', () => {
    expect(localDateSchema.safeParse('2026-09-06T10:00:00Z').success).toBe(false);
    expect(localDateSchema.safeParse('2026-9-6').success).toBe(false);
  });
});

describe('timezoneSchema', () => {
  it('accepts IANA names the runtime knows', () => {
    expect(timezoneSchema.safeParse('Europe/Berlin').success).toBe(true);
    expect(timezoneSchema.safeParse('UTC').success).toBe(true);
  });

  it('rejects a name no timezone database has', () => {
    expect(timezoneSchema.safeParse('Mars/Olympus_Mons').success).toBe(false);
  });

  it('rejects an offset, which cannot answer what day it is a year from now', () => {
    expect(timezoneSchema.safeParse('GMT+2').success).toBe(false);
  });
});

describe('timestampSchema', () => {
  it('accepts a Date and hands it back with its milliseconds intact', () => {
    const instant = new Date('2026-09-06T10:11:12.345Z');
    expect(timestampSchema.parse(instant).toISOString()).toBe('2026-09-06T10:11:12.345Z');
  });

  it('accepts the UTC string a Date turns into once it has been through JSON', () => {
    const parsed = timestampSchema.parse('2026-09-06T10:11:12.345Z');
    expect(parsed).toBeInstanceOf(Date);
    expect(parsed.toISOString()).toBe('2026-09-06T10:11:12.345Z');
  });

  it('rejects an offset, timestamps are stored and carried in UTC', () => {
    expect(timestampSchema.safeParse('2026-09-06T12:11:12+02:00').success).toBe(false);
  });

  it('rejects a bare date and a number', () => {
    expect(timestampSchema.safeParse('2026-09-06').success).toBe(false);
    expect(timestampSchema.safeParse(1_757_152_272_345).success).toBe(false);
  });
});

describe('the closed unions', () => {
  it('has exactly three categories', () => {
    expect(categorySchema.options).toEqual(['green', 'yellow', 'orange']);
    expect(categorySchema.safeParse('red').success).toBe(false);
  });

  it('has three descriptive food kinds', () => {
    expect(foodKindSchema.options).toEqual(['ingredient', 'dish', 'branded']);
  });

  it('keeps ai_vision in the source union even though nothing produces it yet', () => {
    expect(classificationSourceSchema.options).toEqual(['seed', 'ai_text', 'ai_vision', 'user']);
  });

  it('has four meal types', () => {
    expect(mealTypeSchema.options).toEqual(['breakfast', 'lunch', 'dinner', 'snack']);
  });
});

describe('weightGramsSchema', () => {
  it('accepts a positive integer count of grams', () => {
    expect(weightGramsSchema.safeParse(82_400).success).toBe(true);
  });

  it('rejects a fraction of a gram, which is where float drift starts', () => {
    expect(weightGramsSchema.safeParse(82_400.5).success).toBe(false);
  });

  it('rejects zero and negatives', () => {
    expect(weightGramsSchema.safeParse(0).success).toBe(false);
    expect(weightGramsSchema.safeParse(-1).success).toBe(false);
  });
});
