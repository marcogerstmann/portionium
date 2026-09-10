---
id: ADR-007
title: 'Append-only classification log with a resolution rule instead of a mutable category column'
status: Accepted
date: 2026-09-10
---

## Context

A food is green, yellow or orange. That is the entire product, and the obvious way to store it is
a `category` column on `food`, set by the seed loader, corrected by the classifier, corrected
again by whoever disagrees.

Two things make that column wrong here, and neither is a detail.

The first is that a colour is not a fact about a food, it is somebody's opinion about it. Two
people share one instance and one catalog, and they will not agree: peanut butter is orange for
the one who eats it by the spoon and yellow for the one who scrapes it on bread. Both are right
for their own purposes, and a single column can hold only one of them.

The second is that this application is going to guess. An AI classifier is going to answer
"yellow, confidence 0.62, assuming a normal portion", and a human is going to look at that and
sometimes say no. The interesting question a year from now is not what colour anything is, it is
how often the model was wrong, at what confidence, and under which prompt version. A column that
is overwritten by the correction destroys exactly the row that would answer it. The disagreement
is the data.

## Decision

Classifications are an append-only log. `food_classification` holds one row per verdict, carrying
the food, the source (`seed`, `ai_text`, `ai_vision`, `user`), the user it belongs to or null when
it belongs to everybody, and the model's provenance when a model produced it. Rows are never
updated and never deleted. A verdict is corrected by inserting a newer one.

`food` therefore carries no category at all, so there is no field anywhere that a stale colour
could be written to.

Which verdict wins is a pure function, `resolveClassification` in
`api/src/domain/classification.ts`, and it is the only place the order is written down:

1. the caller's own most recent verdict
2. the most recent model verdict visible to them
3. the verdict that shipped with the catalog
4. no colour, which is a state and not a failure

Writing is `api/src/db/classification.ts`, which exposes one write and it inserts. There is no
update and no delete in that module, and that absence is the enforcement: nothing has to remember
the rule, because there is no function that could break it.

## Consequences

Every read costs a resolution. A colour is no longer a column to select, it is a set of rows to
fetch and a function to run over them, and that happens on every list, every detail view and
every meal that renders its foods.

Two things keep that from mattering. The index is `(food_id, user_id, created_at DESC)`, so the
query the resolution rule issues is a search on the leading column rather than a scan of the
table, and the rows it touches are the rows it wants. And resolution is batched:
`resolveClassifications` takes a whole page and one bag of rows, so fifty foods are two queries
rather than fifty one. Both properties have a test in `api/test/classification.test.ts`, which
reads the query plan and counts the statements a page issues, because both are the kind of
property a well meaning refactor removes silently.

What the index does not remove is the ordering. A caller's own verdicts and the shared ones are
two disjoint stretches of it, since `user_id` sits between the food and the timestamp, so the
history query still sorts what it finds and the plan says so. That is deliberate rather than
overlooked: the alternative is an index per source of rows, to save a sort over the handful of
verdicts one food has ever collected. The column order is the one the ticket asked for and the
one the lookup wants, and the sort is paid on a set small enough to fit in a sentence.

The table grows and nothing prunes it. That is intended, and the arithmetic is small: a few
hundred seeded rows, one AI verdict per new food, and a handful of overrides per user per food.
A household producing a thousand verdicts a year is producing well under a megabyte.

What it buys is the analytics this project actually wants. Because a correction sits beside the
verdict it corrected, with the model, the prompt version and the confidence still attached, the
questions are plain queries: how often does a user override the classifier, at what confidence
does it stop being trusted, did prompt version 3 do better than version 2, which foods does
everybody disagree with us about. None of those can be asked of a mutable column, and none of
them needs a schema change to ask here.

The cost paid up front is that a colour can never be read casually. There is no `food.category`
to join to in a report or a quick query, and anything that wants one has to go through the
resolution function with a user in hand. That is the point, but it does mean SQL written outside
this application will get the wrong answer if it reaches for the newest row and stops there.

## Options considered

**A mutable `category` column on `food`.** One column, one write, no resolution on read. Rejected
because it can hold exactly one opinion, which makes a shared catalog a household argument the
database settles by last write wins, and because the correction overwrites the thing worth
measuring. It also fails quietly rather than loudly: the day two users disagree, one of them
simply sees the other's colour and nothing anywhere says so.

**Two tables, a global category on `food` plus a `user_food_override` table.** Closer, and
tempting, because it makes the common read a single column and the override the exception.
Rejected on three counts. It needs the same resolution logic anyway, since a read has to check
the override table before trusting the column, so it buys no simplicity on the read path, only a
second place for the rule to be forgotten. It still overwrites: the global column is where the
seed verdict and the AI verdict fight, and the AI verdict wins by destroying the seed one. And an
override is a row that is updated when a user changes their mind, so the history of one person's
own opinions is lost too, which is the second half of the analytics story.

**An event log with projections into a materialised `resolved_category` table.** The same
append-only property with the read cost engineered away. Rejected as premature: the projection
has to be invalidated per user per food, which is more moving parts than the resolution it
replaces, for a query that reads a few rows through a covering index on a database that is one
file on one machine. See ADR 001 and ADR 005 for the same instinct applied elsewhere. If the read
cost ever shows up, this is the design to reach for, and nothing here has to change to allow it,
because the log is already the source of truth.

## What would make us revisit this

A profile showing resolution on the hot path, which today would mean the day view or the search
results, rather than a suspicion that it is expensive. The materialised projection above is the
answer if that happens.

Or the opposite signal: a year of use in which nobody ever overrides a verdict and no analysis is
ever run against the log. That would say the disagreement this design exists to preserve was not
real, and a column would have done.
