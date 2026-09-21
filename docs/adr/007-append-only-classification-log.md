---
id: ADR-007
title: 'Append-only classification log with a resolution rule instead of a mutable category column'
status: Accepted
date: 2026-09-10
---

## Context

A food is green, yellow or orange. That is the entire product, and the obvious way to store it is a
`category` column on `food`, set by the seed loader, corrected by the classifier, corrected again
by whoever disagrees. Two things make that column wrong here, and neither is a detail.

A colour is not a fact about a food, it is somebody's opinion about it. Two people share one
instance and one catalog, and they will not agree: peanut butter is orange for the one who eats it
by the spoon and yellow for the one who scrapes it on bread. A single column holds one of them.

And this application is going to guess. An AI classifier will answer "yellow, confidence 0.62,
assuming a normal portion", and a human will sometimes say no. The interesting question a year from
now is not what colour anything is, it is how often the model was wrong, at what confidence, and
under which prompt version. A column overwritten by the correction destroys exactly the row that
would answer that. The disagreement is the data.

## Decision

Classifications are an append-only log. `food_classification` holds one row per verdict, carrying
the food, the source (`seed`, `ai_text`, `ai_vision`, `user`), the user it belongs to or null when
it belongs to everybody, and the model's provenance when a model produced it. Rows are never
updated and never deleted; a verdict is corrected by inserting a newer one. `food` therefore
carries no category at all, so there is no field anywhere a stale colour could be written to.

Which verdict wins is a pure function, `resolveClassification` in
`api/src/domain/classification.ts`, and it is the only place the order is written down: the
caller's own most recent verdict, then the most recent model verdict visible to them, then the
verdict that shipped with the catalog, then no colour, which is a state and not a failure.

Writing is `api/src/db/classification.ts`, which exposes one write and it inserts. There is no
update and no delete in that module, and that absence is the enforcement: nothing has to remember
the rule, because there is no function that could break it.

## Consequences

What this buys is the analysis this project actually wants. A correction sits beside the verdict it
corrected, with the model, prompt version and confidence still attached, so the questions are plain
queries: how often does a user override the classifier, at what confidence does it stop being
trusted, did prompt version 3 beat version 2. None of those can be asked of a mutable column.

The costs:

- **Every read costs a resolution.** A colour is a set of rows to fetch and a function to run over
  them, on every list, every detail view and every meal that renders its foods. Two things keep
  that from mattering: the index is `(food_id, user_id, created_at DESC)`, and resolution is
  batched, so fifty foods are two queries rather than fifty one. Both have a test in
  `api/test/classification.test.ts` that reads the query plan and counts statements, because both
  are the kind of property a well meaning refactor removes silently.
- **A colour can never be read casually.** There is no `food.category` to join to in a report, so
  SQL written outside this application will get the wrong answer if it reaches for the newest row
  and stops there.
- **The table grows and nothing prunes it.** Intended, and small: a household producing a thousand
  verdicts a year is producing well under a megabyte.

[ADR 011](./011-an-entry-is-a-colour.md) later gave a logged **entry** its own `category`, stamped
when it is written. That is not the materialised projection rejected below and it does not make
this log mutable: this log remains the only source of a **food's** colour, and an entry's colour is
a fact about something that happened rather than a cache that can go stale.

## Options considered

**A mutable `category` column on `food`.** One column, one write, no resolution on read. It holds
exactly one opinion, which makes a shared catalog a household argument the database settles by last
write wins, and the correction overwrites the thing worth measuring. It also fails quietly: the day
two users disagree, one simply sees the other's colour and nothing says so.

**Two tables, a global category on `food` plus a `user_food_override` table.** Closer, and
tempting, because it makes the common read a single column. Rejected on three counts. A read still
has to check the override table before trusting the column, so it needs the same resolution logic
and only adds a second place to forget it. The global column is still where the seed verdict and
the AI verdict fight, and the AI verdict wins by destroying the seed one. And an override is
updated when a user changes their mind, so one person's own history is lost too.

**An event log with projections into a materialised `resolved_category` table.** The same
append-only property with the read cost engineered away. Premature: the projection has to be
invalidated per user per food, which is more moving parts than the resolution it replaces, for a
query reading a few rows through a covering index on a file on one machine. If the read cost ever
shows up this is the design to reach for, and nothing has to change to allow it, because the log is
already the source of truth.

## What would make us revisit this

A profile showing resolution on the hot path, the day view or the search results, rather than a
suspicion that it is expensive. The materialised projection above is then the answer.

Or the opposite signal: a year in which nobody ever overrides a verdict and no analysis is ever run
against the log. That would say the disagreement this design preserves was not real, and a column
would have done.
