import type { DayColourStats, LocalDate, WeightTrendDay } from '@portionium/schemas';
import { describe, expect, it } from 'vitest';

import {
  changeLabel,
  changeSentence,
  CHART,
  chartGeometry,
  lastReading,
  rangeEnding,
  spokenCounts,
  totalColours,
  trendCaveat,
  versusSentence,
  weekLabel,
} from './stats';

function colourDay(date: LocalDate, green: number, orange: number): DayColourStats {
  const counts = { green, yellow: 0, orange, unclassified: 0 };
  const total = green + orange || 1;

  return {
    date,
    counts,
    share: { green: green / total, yellow: 0, orange: orange / total, unclassified: 0 },
  };
}

function trendDay(
  date: LocalDate,
  trendKg: number | null,
  rawKg: number | null,
  lowConfidence = false,
): WeightTrendDay {
  return { date, trendKg, lowConfidence, movingAverageKg: null, rawKg };
}

describe('rangeEnding', () => {
  it('includes both ends, so seven days is today and the six before it', () => {
    expect(rangeEnding('2026-09-13', 7)).toEqual({ from: '2026-09-07', to: '2026-09-13' });
  });
});

describe('totalColours', () => {
  const days = [
    colourDay('2026-09-11', 1, 1),
    colourDay('2026-09-12', 2, 0),
    colourDay('2026-09-13', 3, 1),
  ];

  it('adds up the tail of the range, because position in the array is the date', () => {
    expect(totalColours(days, 2)).toEqual({ green: 5, yellow: 0, orange: 1, unclassified: 0 });
  });

  it('takes everything there is when the window is longer than the range', () => {
    expect(totalColours(days, 90)).toEqual({ green: 6, yellow: 0, orange: 2, unclassified: 0 });
  });
});

describe('spokenCounts', () => {
  it('names the three colours always and the unclassified count only when there is one', () => {
    expect(spokenCounts({ green: 4, yellow: 2, orange: 1, unclassified: 0 }, 'en-US')).toBe(
      '4 green, 2 yellow, 1 orange',
    );
    expect(spokenCounts({ green: 4, yellow: 2, orange: 1, unclassified: 3 }, 'en-US')).toBe(
      '4 green, 2 yellow, 1 orange, 3 not classified yet',
    );
  });

  it('names them in German too', () => {
    expect(spokenCounts({ green: 4, yellow: 2, orange: 1, unclassified: 0 }, 'de')).toBe(
      '4 grün, 2 gelb, 1 orange',
    );
  });
});

describe('trendCaveat', () => {
  it('says so when nobody has ever weighed', () => {
    expect(trendCaveat([trendDay('2026-09-13', null, null)], 'en-US')).toMatch(
      /No weight recorded/,
    );
  });

  it('says so when the value is real but thin, rather than drawing a confident line', () => {
    expect(trendCaveat([trendDay('2026-09-13', 81.6, 81.4, true)], 'en-US')).toMatch(
      /Not enough readings/,
    );
  });

  it('is silent once the latest day carries a trend the server stands behind', () => {
    expect(trendCaveat([trendDay('2026-09-13', 81.6, null)], 'en-US')).toBeUndefined();
  });

  it('asks the last day rather than the first, because the position that matters is now', () => {
    const days = [trendDay('2026-09-12', null, null), trendDay('2026-09-13', 81.6, 81.4)];

    expect(trendCaveat(days, 'en-US')).toBeUndefined();
  });
});

describe('lastReading', () => {
  it('is the most recent thing that was on the scale, not the most recent trend value', () => {
    const days = [
      trendDay('2026-09-11', 82.0, 82.2),
      trendDay('2026-09-12', 81.8, 81.4),
      trendDay('2026-09-13', 81.7, null),
    ];

    expect(lastReading(days)).toBe(81.4);
  });

  it('is nothing at all when nobody has weighed in the range', () => {
    expect(lastReading([trendDay('2026-09-13', null, null)])).toBeUndefined();
  });
});

describe('changeLabel', () => {
  it('carries the sign in both directions and says nothing rather than zero when there is none', () => {
    expect(changeLabel(-0.4, 'en-US')).toBe('-0.4 kg');
    expect(changeLabel(0.3, 'en-US')).toBe('+0.3 kg');
    expect(changeLabel(null, 'en-US')).toBe('no trend yet');
  });

  it('formats with the active language, a comma decimal separator in German', () => {
    expect(changeLabel(0.3, 'de')).toBe('+0,3 kg');
    expect(changeLabel(null, 'de')).toBe('noch kein Trend');
  });
});

describe('changeSentence', () => {
  it('names the direction, the amount and the weekly rate', () => {
    const change = { from: '2026-08-15', to: '2026-09-13', changeKg: -0.6, changePerWeekKg: -0.14 };

    expect(changeSentence(change, 30, 'en-US')).toBe('Down 0.6 kg over 30 days, 0.14 kg a week.');
  });

  it('leaves the rate out when the stretch measured is a single day', () => {
    const change = { from: '2026-09-13', to: '2026-09-13', changeKg: 0.2, changePerWeekKg: null };

    expect(changeSentence(change, 30, 'en-US')).toBe('Up 0.2 kg over 30 days.');
  });

  it('says there is nothing yet rather than reporting a change of zero', () => {
    const change = { from: null, to: null, changeKg: null, changePerWeekKg: null };

    expect(changeSentence(change, 30, 'en-US')).toBe('Nothing to report over 30 days yet.');
  });
});

describe('versusSentence', () => {
  it('reads the sign the server already subtracted, negative being further down', () => {
    expect(versusSentence({ differenceKg: -0.2, differencePerWeekKg: -0.05 }, 'en-US')).toMatch(
      /0.05 kg a week further down/,
    );
    expect(versusSentence({ differenceKg: 0.2, differencePerWeekKg: 0.05 }, 'en-US')).toMatch(
      /further up/,
    );
  });

  it('has nothing to say when either period has no trend behind it', () => {
    expect(
      versusSentence({ differenceKg: null, differencePerWeekKg: null }, 'en-US'),
    ).toBeUndefined();
  });
});

describe('weekLabel', () => {
  it('collapses a shared month into one range', () => {
    const label = weekLabel({ startDate: '2026-09-07', endDate: '2026-09-13' }, 'en-US');

    expect(label).toMatch(/7/);
    expect(label).toMatch(/13/);
    expect(label.match(/Sep/g)).toHaveLength(1);
  });
});

describe('chartGeometry', () => {
  const days = [
    trendDay('2026-09-11', 82.0, 82.2),
    trendDay('2026-09-12', 81.8, null),
    trendDay('2026-09-13', 81.6, 81.4),
  ];

  it('widens with the range, so the drawn scale stays near one at any screen width', () => {
    expect(chartGeometry(days).width).toBeLessThan(chartGeometry([...days, ...days]).width);
  });

  it('puts the highest value at the top and the lowest at the bottom', () => {
    const { raw, height } = chartGeometry(days);
    const [first, last] = raw;

    expect(first?.y).toBeLessThan(last?.y ?? 0);
    expect(last?.y).toBeLessThanOrEqual(height);
    expect(first?.y).toBeGreaterThanOrEqual(0);
  });

  it('draws a point only where somebody stood on the scale, and a line across every day', () => {
    const { raw, line } = chartGeometry(days);

    expect(raw).toHaveLength(2);
    expect(line.split(' ')).toHaveLength(3);
  });

  it('puts a series with nothing to scale on the middle rather than dividing by zero', () => {
    const flat = chartGeometry([trendDay('2026-09-13', 81.6, 81.6)]);

    expect(flat.raw[0]?.y).toBe(CHART.height / 2);
    expect(flat.line).not.toMatch(/NaN/);
  });

  it('has no line to draw before the first reading anybody made', () => {
    expect(chartGeometry([trendDay('2026-09-13', null, null)]).line).toBe('');
  });
});
