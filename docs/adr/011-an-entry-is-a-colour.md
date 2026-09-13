---
id: ADR-011
title: 'An entry is a colour, stamped at write, not a projection of its food'
status: Accepted
date: 2026-09-13
---

## Context

The unit of this diary is an **entry**, and an entry means one thing: green, yellow or orange, or
not yet judged. Everything else is scaffolding around that.

A **food** is a name for a colour. It is a preset: it saves typing, it remembers what colour this
thing usually is, and it is what the search, the catalog and the review queue are about. It is not
what gets counted.

A **meal** is a bracket around entries. It says when, and it groups. It is not what gets counted
either.

The code had this backwards. `meal_item` required a food, had no colour of its own, and every read
of a day or a statistic re-derived each item's colour from that food's classification log through
`resolveClassification`, at ten call sites across the meal and stats routes. Two things follow from
that, and both are wrong.

A bare colour was not expressible. Somebody who ate something they cannot name, or will not spend
thirty seconds naming, had nowhere to put it, and the only way in was to create a catalog entry for
it. The catalog is shared, so that is a permanent row in everybody's search results in exchange for
one lunch.

And recolouring a food silently rewrote every day it had ever been eaten on. Deciding today that
peanut butter is orange turned a green fortnight last spring orange, retroactively, without anybody
asking for that. A diary that rewrites its own history on a change of opinion is not a record of
anything.

## Decision

An entry carries its own colour, written when it is logged and never recomputed.

`meal_item` becomes `entry`. `food_id` becomes nullable, `category` is added, and a
`CHECK (food_id IS NOT NULL OR category IS NOT NULL)` makes the four combinations mean something:

- a food and a colour: a food logged with the colour it had then
- a food and no colour: waiting for a verdict
- no food and a colour: a bare colour
- neither: forbidden by the database, not by application code

`POST /meals` and `PATCH /meals/{id}` stamp it. An entry that names a food and no colour gets
whatever `resolveClassification` answers for that caller at that moment; an entry that names a
colour keeps it. That is now the only place on the meal path where resolution happens. Repeating a
meal with `fromMealId` is a write like any other, so it restamps rather than copying.

One thing moves a colour after the fact, and only in one direction: a `user` verdict fills in the
entries that were still waiting. That runs inside `insertClassifications`, in the same transaction
as the verdict, so the three endpoints that write one cannot forget it and neither can the AI
confirm and reject to come. An entry that already carries a colour is never rewritten, whatever the
source. A `seed` or `ai_*` verdict never touches an entry at all, and withdrawing an override never
un-colours one.

## The line against ADR 007

[ADR 007](./007-append-only-classification-log.md) is untouched, and this is deliberately not a
reversal of it. The classification log remains the only source of a **food's** colour, it remains
append-only, and no verdict becomes mutable. ADR 007 rejected a materialised `resolved_category` on
`food`, a cache of a projection that would have to be invalidated whenever the log grew, and that
rejection still stands: this adds no such column.

What is new is a different kind of fact. An **entry's** colour is not a projection of the log at
all, it is a property of something that happened, the way `local_date` is a property of the meal
that carried it rather than a rendering of `logged_at` done afresh on every read. It is written once,
by the event, and it is not derived from anything afterwards. A cache that can go stale and a record
of what happened look alike in a schema and are opposites in meaning.

## Consequences

Reads get cheaper and simpler. `GET /days/{date}`, `GET /meals`, `GET /meals/{id}`, `GET /stats/days`
and `GET /stats/weekly` read a column; `computeDailyColourStats` lost a parameter and the stats
endpoints lost a query each.

A day is stable. Recolouring a food changes what logging it again gives you and leaves every day it
was already eaten on exactly as it was.

A bare colour is expressible, which is what `POST /meals` with `{ category: 'orange' }` now is, and
it costs the shared catalog nothing.

The cost is a trap worth naming: an entry's colour and its food's current colour can now differ, and
they appear side by side on one response. `GET /days/{date}` answers with entries carrying what they
were logged with and a `foods` list carrying each food's colour as it stands now, because that list
is what a client shows in a search box. A client renders the entry's. Anything that reaches for the
food's colour to draw a logged entry has reintroduced the bug this record exists to remove.

The second cost is that a food logged before anybody judged it stays uncoloured until its own owner
says something. A model verdict arriving later does not fill it in, which is the price of never
rewriting history by machine.

## Options considered

**Three catalog entries called Green, Yellow and Orange.** A bare colour becomes an ordinary food,
no migration, no nullable column, no CHECK. Rejected: they would be the three most eaten foods on
the instance within a month, and how often a caller eats something is exactly the signal
`domain/food-search.ts` ranks on, so they would sit permanently at the top of every search box they
were supposed to keep out of.

**Resolve on read, as before, and accept the rewriting.** Rejected on the product: the retroactive
recolouring is not a subtle defect, it is the thing that makes somebody stop trusting the graph.

**A materialised colour on `food`.** That is the option ADR 007 already rejected, and it answers
neither of the two problems here: it is still one colour per food for two people, and it still
rewrites history on a change of opinion.

**Stamp in the repository rather than the route.** Rejected: resolution needs the caller, and
`api/src/domain` may not read the classification log from inside a write. The route has both in hand
and is where every other write-time derivation on this path already happens.

## What would make us revisit this

A model verdict that should reach an entry logged before it. Today only a `user` verdict fills in a
waiting entry, on the grounds that a machine should not colour somebody's history. If the AI
classifier turns out to be good enough that a queue of uncoloured entries is a nuisance rather than a
safeguard, the change is one condition in `colourWaitingEntries`, and it belongs in an ADR that says
so rather than in a commit that widens the filter.
