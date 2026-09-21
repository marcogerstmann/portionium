---
id: ADR-008
title: 'Weight trend smoothing algorithm'
status: Accepted
date: 2026-09-11
---

## Context

A body weight measured once a day is mostly not body weight. Gut contents, hydration, salt from
yesterday's dinner, glycogen, the time of the morning: together they move the reading by a kilo or
more in somebody whose actual mass is not changing at all. Real change, for a person eating
slightly less than they burn, is around a hundred grams a day. The noise is an order of magnitude
larger than the signal.

So the honest number and the useful number are different numbers, and showing the honest one as the
headline is how this app would recreate the experience it exists to remove. Somebody has a good
week, steps on the scale on a salty Sunday, sees a number higher than Monday's, and concludes the
week failed. It did not.

Two things constrain the choice. People skip days, so the series is irregularly sampled and gaps of
a fortnight are normal. And this runs inside a request against a few thousand rows in SQLite, with
no training step, no stored model state and nothing to tune per user.

## Decision

The trend is an **exponentially weighted moving average with a smoothing factor derived from the
days actually elapsed**, defaulting to a **ten day half life**:

```
α     = 1 - 0.5 ^ (gap in days / half life)
trend = trend + α × (reading - trend)
```

It lives in `computeWeightTrend`, in
[`api/src/domain/weight-trend.ts`](../../api/src/domain/weight-trend.ts), as a pure function over
an array of readings. The half life is `WEIGHT_TREND_HALF_LIFE_DAYS`, ten by default, between one
and sixty. The first reading becomes the trend outright: there is nothing behind it to pull
towards, and seeding from a population average would spend a month climbing to a number the user
told us on day one.

There is no gap handling step; it falls out of deriving α from elapsed time. A reading arriving
after g days moves the trend by `1 - 0.5^(g / half life)` of the distance to it: seven percent
after one day, half after ten, sixty two percent after a fortnight. The first reading back after a
holiday is therefore taken mostly at face value, which is correct. On a day with no reading the
trend is **held flat** rather than decayed towards anything, because a line drifting towards a mean
during a gap would show movement nobody did. The raw field is null on those days, so a client can
draw the difference between a measured point and a carried one.

A trend from two readings is thin, and so is one whose most recent reading is three weeks old. Both
are reported as `lowConfidence` rather than withheld, because withholding leaves a user with
nothing at the moment they are most interested. Both come from one accumulator, decayed like the
trend itself, `evidence = evidence × 0.5 ^ (gap / half life) + 1`, so a single number answers "too
few readings" and "too old readings" alike. Below two, the value is flagged: the flag clears on the
third consecutive weigh-in, daily or weekly, and returns after about nineteen days of not weighing.

A seven day simple moving average ships alongside as a secondary field, because it is the number
people recognise from every other weight app. The raw reading is returned last and is never the
primary field.

## Consequences

**The trend lags, and this is the price.** On a steady slope it settles about one time constant
behind the readings, roughly fourteen days at a ten day half life, so somebody losing a hundred
grams a day sees a trend about 1.4 kg above the scale. A unit test asserts that number rather than
leaving it to be discovered. The lag is a level offset, not a rate error: the trend falls at the
same rate the readings do once settled, so the change per week, which the response leads with, is
right even while the absolute value trails.

**A rate measured over a cold window understates itself.** A trend starting on its first reading
spends a half life acquiring its lag, and that is subtracted from the change measured across the
window: the same sixty day decline reads as -540 g/week over its first month and -660 over its
second. This is why the endpoint loads the whole history rather than the requested range, and why
the comparison against the previous period is computed in the same pass and returned already
subtracted, rather than left as arithmetic each client gets to make its own mistake in.

**Nothing is stored.** Correcting a reading from three weeks ago corrects every value after it with
no backfill, and changing the half life changes the history rather than creating a seam. If the
scan ever registers, the fix is to cache per user rather than store per row, because a stored trend
can go stale with respect to an edit.

**A half life is harder to explain than a window.** "The last seven days averaged" is a sentence
anybody understands; "each reading loses half its influence every ten days" is not. The seven day
average ships partly for this reason. Rates are per week for the same reason: nobody has a feel for
grams per day.

## Options considered

**A simple moving average over a window**, which is what most weight trackers show. It weights a
reading from six days ago exactly as much as this morning's and then drops it entirely tomorrow, so
the line moves when nothing happened. It handles gaps badly in a way that is easy to miss: a window
either demands n readings and goes blank for anybody who weighs on weekdays only, or averages
whatever it finds, in which case the number silently means the mean of seven readings on one day
and of two on another. And its lag is not actually better. A seven day mean lags three and a half
days against fourteen here, but only because it smooths much less, reducing ±1 kg of daily noise by
a factor of 2.6 against about 5 for this. Matching the smoothing means a 25 day window, whose lag
is 12 days. It is kept as a secondary field, which costs almost nothing.

**A Kalman filter, or Holt's linear smoothing.** Both model a level and a trend rather than a level
alone, which is mathematically better and genuinely tempting: a Kalman filter would estimate the
rate directly instead of reading it off two endpoints, and would give a variance to put an interval
around the value. Rejected because the extra machinery is paid for in parameters nobody can set. A
Kalman filter needs process and measurement noise covariances, and the honest way to get them is to
fit them per user. Guessing them, which is what would actually happen, produces a filter with the
same behaviour as an exponentially weighted average and four times the code: the steady-state
Kalman gain for a local level model _is_ an exponential smoothing constant. Holt's method needs a
second parameter for the slope, and a slope term extrapolates, so a fortnight of holiday makes it
project a gain that has not happened. The variance is the real loss; the evidence accumulator
answers the same practical question without claiming a distribution the input does not support.

**Interpolating or imputing missing days.** It invents data: a fortnight of unknown weight becomes
a fortnight of confident weight, and the chart looks most certain exactly where it knows least. It
also cannot be done online, since the interpolation needs the reading after the gap, so today's
value would change once somebody weighed tomorrow.

**Outlier rejection before smoothing.** The distinction between an outlier and the beginning of a
real change is not available when the reading arrives, and a filter that rejects the first three
days of a genuine step change is worse than one that lags. Implausible readings, the misplaced
decimal point, are already refused at write time by a cruder rule, `WEIGHT_PLAUSIBILITY` in
[`api/src/domain/weight.ts`](../../api/src/domain/weight.ts).

## What would make us revisit this

- **Somebody looks at the trend and does not believe it**, repeatedly, because it sits visibly
  above or below where the readings are going. The answer is then a shorter half life, or Holt's
  method with a properly fitted slope.
- **Multiple readings a day become normal.** Today the latest wins and the rest are discarded,
  which wastes real data once somebody weighs morning and evening on purpose.
- **Enough history accumulates to fit the parameters** instead of choosing them. A year of one
  person's readings is enough to estimate their own measurement noise, at which point a Kalman
  filter stops being one with guessed constants and the flag can become an interval.
- **The scan stops being free.** Cache per user rather than storing per row.
