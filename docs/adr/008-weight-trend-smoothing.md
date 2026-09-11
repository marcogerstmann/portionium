---
id: ADR-008
title: 'Weight trend smoothing algorithm'
status: Accepted
date: 2026-09-11
---

## Context

A body weight measured once a day is mostly not body weight. Gut contents, hydration, salt from
yesterday's dinner, glycogen, the time of the morning, which scale, which floor: together they move
the reading by a kilo or more, day to day, in somebody whose actual mass is not changing at all.
Real change, for a person eating slightly less than they burn, is somewhere around a hundred grams
a day. The noise is an order of magnitude larger than the signal.

So the honest number and the useful number are different numbers, and showing the honest one as the
headline is how this app would recreate the exact experience it exists to remove. Somebody has a
good week, steps on the scale on a salty Sunday, sees a number higher than Monday's, and concludes
the week failed. It did not. The chart lied by telling the truth about one morning.

What is needed is an estimate of where the weight actually is, updated by each reading rather than
replaced by it, and shown as the primary value with the raw reading kept but demoted.

Two things constrain the choice. People skip days, so the series is irregularly sampled and gaps of
a week or a fortnight are normal rather than exceptional. And this runs inside a request against a
few thousand rows in SQLite, with no training step, no stored model state and nothing to tune per
user, see [ADR 001](./001-sqlite-over-postgresql.md) and
[ADR 005](./005-no-redis-no-metrics-stack.md).

## Decision

The trend is an **exponentially weighted moving average with a smoothing factor derived from the
days actually elapsed**, defaulting to a **ten day half life**:

```
α     = 1 - 0.5 ^ (gap in days / half life)
trend = trend + α × (reading - trend)
```

It lives in `computeWeightTrend`, in
[`api/src/domain/weight-trend.ts`](../../api/src/domain/weight-trend.ts), as a pure function over an
array of readings. The half life is `WEIGHT_TREND_HALF_LIFE_DAYS`, ten by default, between one and
sixty.

The first reading becomes the trend outright rather than being blended into a zero or into a
population average. There is nothing behind it to pull towards, and seeding from anywhere else would
spend a month climbing to a number the user told us on day one.

A seven day simple moving average is computed alongside it and returned as a secondary field,
because it is the number people recognise from every other weight app and it is worth being able to
see the two disagree. The raw reading is returned too, last, and is never the primary field in the
response shape.

## Consequences

**The trend lags.** This is the price and it is not small. On a steady slope the exponentially
weighted average settles about one time constant behind the raw readings, which at a ten day half
life is roughly fourteen days, so somebody losing a hundred grams a day sees a trend sitting about
1.4 kg above the scale. A unit test asserts that number rather than leaving it to be discovered,
because it is the honest cost of the method and the thing a user will eventually notice.

The lag is a level offset, not a rate error: the trend falls at the same rate the readings do once
it has settled, so the change per week, which is what the response leads with, is right even while
the absolute value trails. What is wrong during the lag is the answer to "what do I weigh", which is
what the raw field is still there for.

**A rate measured over a cold window understates itself.** A trend that starts on its first reading
starts with no lag and then spends a half life acquiring one, and that acquisition is subtracted from
the change measured across the window. The same sixty day decline reads as -540 g/week over its first
month and -660 over its second. This is why the endpoint loads the account's whole history rather
than the requested range, and why the range is only the part that gets emitted. It is also why the
comparison against the previous period is computed by the same function in the same pass rather than
by calling it twice, and why the difference between the two periods is subtracted there and returned
already done: the comparison is the claim the product actually makes, and it should not be arithmetic
that each client gets to make its own mistake in.

**Nothing is stored.** The trend is recomputed from the readings on every request, so correcting a
reading from three weeks ago corrects every value after it with no backfill, and changing the half
life changes the history rather than creating a seam. A few thousand readings is a scan that does
not register next to the request that carries it. If a household ever accumulates enough that it
does, the fix is to cache per user rather than to store per row, because a stored trend is a value
that can be stale with respect to an edit.

**Rate per week, not per day.** Nobody has a feel for grams per day. Everybody has a feel for half a
kilo a week.

**A half life is harder to explain than a window.** "The last seven days averaged" is a sentence
anybody understands; "each reading loses half its influence every ten days" is not. The response
carries the seven day average as well partly for this reason.

## Options considered

### Simple moving average over a window

The obvious choice, and what most weight trackers show. Rejected as the primary value for three
reasons, in increasing order of importance.

It weights a reading from six days ago exactly as much as this morning's and then drops it entirely
tomorrow, so the line moves when nothing happened, purely because an old reading fell out of the
window. It has a hard edge where an exponential decay has none.

It handles gaps badly in a way that is easy to miss. A window either demands n readings, and goes
blank for anybody who weighs on weekdays only, or averages whatever it finds, in which case the
number silently means the mean of seven readings on one day and of two on another, with no
indication which.

And its lag is not actually better. A seven day moving average lags the signal by about half its
window, three and a half days, against roughly fourteen for a ten day half life, but only because it
is smoothing much less: a ±1 kg daily noise is reduced by a factor of about 2.6 by a seven day mean
and by about 5 by this. Matching the smoothing means a 25 day window, whose lag is 12 days. The
comparison is not lag against lag, it is lag at a given amount of smoothing, and there the two are
close.

It is kept as a secondary field, which costs almost nothing and gives a familiar reference.

### Kalman filter, or Holt's linear (double exponential) smoothing

Both model a level and a trend rather than a level alone, which is the mathematically better answer
and is genuinely tempting: a Kalman filter with a local linear trend model would estimate the rate of
change directly instead of having it read off two endpoints, and it would give a variance to put a
confidence interval around the value, which is strictly more informative than the boolean this ships.

Rejected because the extra machinery has to be paid for in parameters nobody can set. A Kalman filter
needs a process noise and a measurement noise covariance, and the honest way to get them is to fit
them per user from their own data. Guessing them, which is what would actually happen, produces a
filter with the same behaviour as an exponentially weighted average and four times the code: the
steady-state Kalman gain for a local level model _is_ an exponential smoothing constant. Holt's
method needs a second smoothing parameter for the slope, and a slope term extrapolates, so a fortnight
of holiday makes it project a gain that has not happened yet. Neither is defensible for a
personal tracker where the first user is the author and there is no tuning data.

The variance is the real loss. What ships instead is a single accumulated evidence number, see below,
which answers the same practical question, is this value thin, without claiming a distribution the
input does not support.

### Interpolating or imputing missing days

Fill the gap with a straight line between the reading before it and the one after, then smooth daily.
Rejected: it invents data. A fortnight of unknown weight becomes a fortnight of confident weight
drawn as a smooth line, and the chart shows its most certain-looking segment exactly where it knows
the least. It also cannot be done online, since the interpolation needs the reading after the gap, so
today's value would change retroactively once somebody weighed tomorrow.

### Outlier rejection before smoothing

Drop readings that sit more than some distance from the current trend. Rejected here because the
distinction between an outlier and the beginning of a real change is not available at the time the
reading arrives, and a filter that rejects the first three days of a genuine step change is worse
than one that lags. Implausible readings, the misplaced decimal point, are already refused at write
time by a separate and much cruder rule, see `WEIGHT_PLAUSIBILITY` in
[`api/src/domain/weight.ts`](../../api/src/domain/weight.ts).

## How gaps are treated, and why

There is no gap handling step. It falls out of deriving α from elapsed time.

A reading arriving after g days moves the trend by `1 - 0.5^(g/half life)` of the distance to it: six
or seven percent after one day, half after ten, sixty two percent after a fortnight. So the first
reading back after a holiday is taken mostly at face value, which is correct, because a ten day old
estimate genuinely has little to say about today. Nothing is imputed, interpolated, or carried into
the average.

On a day with no reading the trend is **held flat** at its last value rather than decayed towards
anything. No news is not news: the last thing known is still the best estimate of today, and a line
that drifted towards zero or towards a mean during a gap would show movement that nobody did. The
raw field is null on those days, so a client can draw the difference between a measured point and a
carried one.

## The confidence flag

A trend from two readings is a real number and a thin one, and so is a trend whose most recent
reading is three weeks old. Both are reported as `lowConfidence` rather than withheld, because
withholding leaves a user with nothing at the exact moment they are most interested.

Both come from one accumulator, updated with the same decay as the trend itself:

```
evidence = evidence × 0.5 ^ (gap / half life) + 1
```

Each reading adds one and time erodes what is already there, so a single number answers both "too
few readings" and "too old readings". Below two, the value is flagged. In practice that means the
flag clears on the third consecutive daily weigh-in, or the third weekly one, and returns after
about nineteen days of not weighing at all.

Two is a judgement call, not a derivation. It is roughly "two readings' worth of undecayed
evidence", which is the point at which the estimate stops being one morning's number.

## What would make us revisit this

- **Somebody looks at the trend and does not believe it**, repeatedly, because it sits visibly above
  or below where the readings are going. That is the lag becoming user-visible, and the answer is a
  shorter half life, or Holt's method with a properly fitted slope, not a tweak here.
- **Multiple readings a day become normal** rather than occasional. Today the latest reading wins and
  the rest are discarded from the trend, which is a waste of real data once somebody weighs morning
  and evening on purpose. Averaging within a day, or using the time of day as a covariate, becomes
  worth the complexity.
- **Enough history accumulates to fit the parameters** instead of choosing them. A year of one
  person's readings is enough to estimate their own measurement noise, at which point a Kalman filter
  stops being a filter with guessed constants and starts being one with real ones, and the confidence
  flag can become a confidence interval.
- **The scan stops being free.** It is linear in the readings on record and runs on every request. If
  a range query ever shows up in a slow log, cache per user rather than storing per row.
