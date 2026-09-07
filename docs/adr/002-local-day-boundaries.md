---
id: ADR-002
title: 'Local day boundaries, per-user timezone, and handling of backdated edits'
status: Accepted
date: 2026-09-07
---

## Context

Everything this app shows is grouped by a day. The streak, the daily traffic light, the weekly
summary, the weight trend. So "which day did this happen on" is not a display detail, it is the
grouping key underneath every number the user reads.

Two things make that question harder than it looks.

A timezone offset is a property of an instant, not of a place. Berlin is one hour ahead of UTC
in January and two in July, and on the two transition days it is both. Any answer derived from a
single remembered offset is wrong for part of the year, and wrong in a way that shows up as one
duplicated or one missing day rather than as an error.

And a calendar day is not what a person means by a day. A meal at 01:00 is the end of an
evening, not the start of a morning. Filed at midnight, it lands on a day the user has not
lived yet, splits one evening across two rows, and breaks a streak they did not break.

There is also a third pressure that only appears later. Users move, and users travel. Whatever
is decided about the first two questions has to survive the timezone on the account changing
after rows already exist.

## Decision

One function, `resolveLocalDate(instant, timezone, boundaryHour)` in
[`api/src/domain/local-date.ts`](../../api/src/domain/local-date.ts), converts a UTC instant to
a `YYYY-MM-DD` local date. It is the only place in the codebase where that conversion happens.

Its result is written to a `local_date` column next to the instant at insert time. Aggregates
group by that stored column and never convert at read time. `createMeal` in
[`api/src/domain/meal.ts`](../../api/src/domain/meal.ts) derives it rather than accepting it, so
`NewMeal` has no `localDate` field for an adapter to fill in and no meal can be stored carrying
a day that contradicts its own instant.

The conversion is done with the Temporal API, through `@js-temporal/polyfill` for now. Temporal
is unflagged from Node 26, which reaches Active LTS on 2026-10-28, so the polyfill is a bridge
of roughly seven weeks and not a lasting dependency. Removing it is deleting one import and
adding `ESNext.Temporal` to `lib` in `tsconfig.base.json`. The code that uses it does not
change, because it is the same API either way.

The boundary hour is a per-user column, `user.day_boundary_hour`, defaulting to 4. An instant
whose local wall clock hour is below the boundary belongs to the previous calendar day.

Changing `user.timezone` or `user.day_boundary_hour` does not rewrite any existing `local_date`.

## Consequences

Easier:

- Grouping is `GROUP BY local_date` on an indexed text column. SQLite cannot apply an IANA zone
  in a query, so had this been computed on read, every aggregate would have had to load rows
  into the process and group them there.
- One function to test, and DST is testable without a server, a clock or a fake timer. The test
  cases in [`local-date.test.ts`](../../api/src/domain/local-date.test.ts) are the real
  deliverable of this decision. They are written as pairs of UTC instants straddling a
  boundary, so they assert behaviour rather than implementation: the whole conversion was moved
  from `Intl` to Temporal without a single one of them changing.
- Temporal has no ambiguous cases in the direction this code goes. An instant maps to exactly
  one wall clock, and calendar arithmetic happens on a zoneless date, so neither the 23 hour
  day nor the 25 hour day needs handling.
- The stored day is stable. A chart rendered today and the same chart rendered next year show
  the same bars, whatever has happened to the user's account in between.

Harder:

- `local_date` is denormalised, so it can disagree with `logged_at` if anything ever writes it
  without going through `resolveLocalDate`. The mitigation is that there is exactly one place to
  look, not a constraint the database can enforce, and that the domain factory derives the value
  rather than accepting one.
- A dependency, until the Node 26 bump. It is pinned at `0.5.1`, which reads as young, but the
  API it implements is a frozen standard rather than a vendor's design, so the version number is
  about the packaging and not about churn.
- A user who moves has a seam in their history, see below.
- Correcting a genuinely wrong `local_date`, from a bug rather than from a move, needs a
  deliberate backfill migration. That is the intended cost. It makes rewriting history a thing
  somebody has to choose to do.

## Options considered

**Compute the local date at read time from `logged_at` and the user's current timezone.**
Rejected. It reads as the cleaner design, one source of truth and no denormalised column, and it
is wrong for two independent reasons. The grouping key stops being indexable, so every summary
becomes a full scan plus in process grouping. Worse, it makes history mutable: a user who moves
from Berlin to Auckland sees months of past evenings silently shift to the next day, breaking
streaks that were genuinely earned. History is a record of what happened, and what happened
happened in the zone the user was in at the time.

**Store the local date but compute it from the user's current timezone during a nightly
recompute.** Rejected for the same reason with extra machinery.

**Store an offset alongside each instant instead of a resolved date.** Rejected. It keeps enough
information to recompute, which sounds strictly better, but the grouping key still has to be
derived at read time, so it buys nothing for the query that matters and costs a column.

**Midnight as the boundary, matching the calendar.** Rejected. It is the wrong model of a day
for the one behaviour this app tracks. Late night eating is exactly the pattern a food log
should record honestly, and midnight is the point at which it gets recorded dishonestly.

**A fixed 04:00 boundary for everyone, no column.** Rejected, narrowly. Four in the morning suits
almost everyone: it is after any plausible end of an evening and before any plausible breakfast,
so it sits in the quietest hour of the eating day and misfiles the fewest meals. But shift
workers exist, and for them it is not close to right. The column costs one integer with a
default and no signup question, so the default carries the common case and the column carries
the rest.

**`Intl.DateTimeFormat` with a `timeZone`, and no dependency at all.** Rejected, though it very
nearly won. It is ICU's IANA database and it is the same mechanism `timezoneSchema` in
`@portionium/schemas` already uses to validate zone names, so it honours the rule that matters,
which is that timezone maths must never be done with `Date` offset arithmetic. What it cannot
do is express the second half of the problem. Reading a wall clock out of a formatter means
picking fields out of `formatToParts` by name and caching a formatter per zone, and stepping
back a day then falls to `Date` arithmetic on a date string. Both work, both are code that
exists only because the API is a formatter being used as a calendar.

**Luxon, or date-fns-tz.** Rejected. Both are correct and either would have done. They lose to
Temporal on one point: they are permanent dependencies, where Temporal is a temporary one.

**A fixed offset stored per user, or `getTimezoneOffset()`.** Rejected, and recorded only so
the reason is written down. An offset is a property of an instant, not of a zone. Berlin is
`+01:00` in January and `+02:00` in July, so any offset read once and reused is wrong for part
of the year, and wrong by exactly one day at the boundary rather than loudly.

## What would make us revisit this

Node 26 reaching Active LTS on 2026-10-28, which is when the polyfill comes out. Check
`typeof Temporal` on the actual deploy target before deleting it and not only on a laptop, there
are Node 26 builds in the wild that still want `--harmony-temporal` despite being compiled with
Temporal support.

A feature that has to show history in the user's current zone rather than the zone they logged
it in. Travel across zones within a single day, where per-trip zones rather than a per-account
zone start to matter. Or a user request to move their history after a permanent move, which
would be a backfill migration and an amendment to this ADR, not a change to how reads work.
