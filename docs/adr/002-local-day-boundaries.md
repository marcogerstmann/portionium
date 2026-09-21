---
id: ADR-002
title: 'Local day boundaries, per-user timezone, and handling of backdated edits'
status: Accepted
date: 2026-09-07
---

## Context

Everything this app shows is grouped by a day: the streak, the daily traffic light, the weekly
summary, the weight trend. "Which day did this happen on" is therefore the grouping key underneath
every number a user reads, not a display detail.

Two things make that harder than it looks. A timezone offset is a property of an instant, not of a
place, so any answer derived from a single remembered offset is wrong for half the year, and wrong
as one duplicated or missing day rather than as an error. And a calendar day is not what a person
means by a day: a meal at 01:00 is the end of an evening, and filed at midnight it lands on a day
the user has not lived yet and breaks a streak they did not break. A third pressure arrives later,
because users move and travel, so whatever is decided has to survive the timezone on an account
changing after rows already exist.

## Decision

One function, `resolveLocalDate(instant, timezone, boundaryHour)` in
[`api/src/domain/local-date.ts`](../../api/src/domain/local-date.ts), converts a UTC instant to a
`YYYY-MM-DD` local date, and it is the only place that conversion happens. Its result is written to
a `local_date` column next to the instant at insert time; aggregates group by that column and never
convert on read. `createMeal` derives it rather than accepting it, so no adapter can supply a day
that contradicts its own instant.

The boundary hour is a per-user column, `user.day_boundary_hour`, defaulting to 4. An instant whose
local wall clock hour is below it belongs to the previous calendar day. Changing `user.timezone` or
the boundary hour does not rewrite any existing `local_date`.

The conversion uses Temporal through `@js-temporal/polyfill`. Temporal is unflagged from Node 26,
which reaches Active LTS on 2026-10-28, so the polyfill is a bridge of about seven weeks rather
than a lasting dependency.

## Consequences

Grouping is `GROUP BY local_date` on an indexed text column. SQLite cannot apply an IANA zone in a
query, so computed on read, every aggregate would have had to load rows into the process and group
them there. The stored day is also stable: the same chart rendered next year shows the same bars.
One function is testable without a server or a fake clock, and the DST cases in
[`local-date.test.ts`](../../api/src/domain/local-date.test.ts) assert behaviour rather than
implementation, which is why the conversion moved from `Intl` to Temporal without one of them
changing.

The costs:

- `local_date` is denormalised and can disagree with `logged_at` if anything writes it without
  going through `resolveLocalDate`. The mitigation is one place to look, not a database constraint.
- A dependency until the Node 26 bump, pinned at `0.5.1`. The version reads as young, but the API
  it implements is a frozen standard rather than a vendor's design.
- A user who moves has a seam in their history, and correcting a genuinely wrong `local_date`, from
  a bug rather than a move, needs a deliberate backfill migration. That is the intended cost: it
  makes rewriting history something somebody has to choose to do.

## Options considered

**Compute the local date on read from `logged_at` and the user's current timezone.** Reads as the
cleaner design and is wrong twice over. The grouping key stops being indexable, so every summary
becomes a full scan plus in-process grouping. Worse, it makes history mutable: a user moving from
Berlin to Auckland sees months of past evenings shift to the next day, breaking streaks genuinely
earned. A nightly recompute into a stored column is the same objection with extra machinery.

**Store an offset alongside each instant instead of a resolved date.** Keeps enough to recompute,
but the grouping key still has to be derived on read, so it buys nothing for the query that matters
and costs a column. Storing a fixed offset per user is worse: an offset read once and reused is
wrong for half the year.

**Midnight as the boundary.** The wrong model of a day for the one behaviour this app tracks. Late
night eating is exactly what a food log should record honestly, and midnight is where it starts
being recorded dishonestly.

**A fixed 04:00 boundary for everyone, no column.** Rejected narrowly: four in the morning misfiles
the fewest meals, but shift workers exist. The column costs one integer with a default and no
signup question.

**`Intl.DateTimeFormat`, and no dependency at all.** Very nearly won: same ICU database, and no
`Date` offset arithmetic. What it cannot do is the second half of the problem. Reading a wall clock
out of a formatter means picking fields out of `formatToParts` by name, and stepping back a day
then falls to `Date` arithmetic on a date string. Luxon and date-fns-tz do it properly and lose on
one point: they are permanent dependencies where Temporal is a temporary one.

## What would make us revisit this

Node 26 reaching Active LTS on 2026-10-28, which is when the polyfill comes out. Check
`typeof Temporal` on the actual deploy target, not only on a laptop.

Travel across zones within a day, where per-trip zones start to matter more than a per-account one.
Or a request to move history after a permanent move, which would be a backfill migration and an
amendment here, not a change to how reads work.
