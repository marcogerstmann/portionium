---
id: ADR-006
title: 'Single foods table for ingredients and dishes, no composition'
status: Accepted
date: 2026-09-10
---

## Context

A user logs "Spaghetti Bolognese". That is one thing on a plate and one thing in a sentence, but
it is also pasta, minced beef, tomatoes and a spoon of oil, and there is a well trodden way to
model the difference: ingredients in one table, dishes in another, a recipe table joining the
two, and a portion size on each edge. Every nutrition app on the market is built that way,
because every nutrition app on the market is adding up calories, and you cannot add up what you
have not broken down.

This one does not add anything up. The whole product is a traffic light: a food is green, yellow
or orange, a day is a row of dots, and nobody weighs anything. See ADR 001 for the same instinct
applied to the database, and the seed catalog rule in `api/seed/foods.json` for what a colour
means.

So the modelling question is not "how do we represent a recipe", it is "does a recipe change any
answer this product gives". If a dish is decomposed into four ingredients with four colours,
something still has to decide what colour the dish is, and that decision cannot come from the
parts: a bowl of pasta with a spoon of olive oil is not orange because olive oil is orange. The
composition would be data we carry, migrate and keep consistent in order to throw it away at
the moment of use.

## Decision

One table, `food`, holding ingredients, dishes and branded products alike. `kind` is a
descriptive label, nothing branches on it, and it exists so a list can be grouped and a filter
can narrow. A dish is a flat catalog entry with a name and its own colour, exactly like an
ingredient.

`meal_item` therefore points at `food` with a plain foreign key, and there is no recipe table,
no parent food, and no composition of any kind.

## Consequences

A meal item is one column pointing at one table. Every read path, the day view, the streaks,
the search and the classifier, deals with one kind of row, so none of them carries a branch for
"is this a dish". The classifier is asked one question per food and gives one answer, which is
also what makes the append only classification log tractable: a verdict is about a row, not
about a tree.

A dish gets one colour as a whole, which is the product's position rather than a limitation.
"Spaghetti Bolognese is yellow" is a sentence a person can agree or disagree with, and
disagreeing with it is one tap. "Spaghetti Bolognese is 43 percent yellow by mass" is not a
sentence anybody wanted.

The cost is that a dish cannot be decomposed later without a new join table. Nothing recorded
today says a lasagne contains pasta, so a future feature that wants to substitute an ingredient,
or to explain a colour by pointing at the thing that caused it, has to be given that data by
somebody. There is no migration that can derive it.

That table, when it exists, points back at this one: `food_component(parent_food_id,
child_food_id, ...)`, both columns referencing `food`. Nothing built here changes, because a
dish is already a row with an id, and the composition is an edge between two rows that already
exist. This is the reason the single table is not a corner: it is the shape a composition model
would need underneath it anyway.

A smaller consequence, worth writing down because a shared table makes it sharper than it looks:
one entry serves everybody, so changing one changes what everybody sees. Editing and deleting are
therefore gated the same way, to the entry's author or an administrator. A rename is not the
gentler of the two: an entry renamed out from under somebody is gone from their search and
mislabelled in their history, and it takes their meals with it, so a lock on the delete beside an
open rename would be a door next to an open window. A seeded entry has no author, which makes it
nobody's and therefore an administrator's. A food any meal references cannot be deleted at all,
whoever asks, see the `food-in-use` problem type.

## Options considered

**A separate `dish` entity, with `meal_item` referencing either it or `food`.** Rejected because
the reference has to be polymorphic: either two nullable foreign key columns with a check
constraint saying exactly one is set, or a type discriminator plus an untyped id, which gives up
referential integrity outright. Both make every join in the application a two case join, and
both put the burden on code that has nothing to do with dishes. The thing being modelled is
"something you ate", and there is exactly one of those.

**A recipe composition model: `dish`, `ingredient`, and a quantity carrying join.** Rejected
because it is the calorie counting data model, and it arrives with the calorie counting product
attached. It needs a portion on every edge, which needs the user to know how much pasta was in
the bowl, which is precisely the question this product exists to not ask. It would also have to
answer "what colour is the dish" from the parts, which no defensible rule does, and the fallback
of storing the dish's colour anyway makes the composition decorative.

**One table with a nullable self reference for a parent food.** Rejected as the worst of both:
it carries the modelling cost of composition, a nullable column and a cycle to guard against, in
exchange for a single level of nesting nobody asked for and nothing reads. If composition is
ever wanted, a join table expresses it properly and can be added on the day it is wanted.

## What would make us revisit this

A user asking, in words, why a food is the colour it is, and the honest answer being about an
ingredient. That is the point at which one colour per dish stops being a clear position and
starts being a missing explanation, and it is a feature request rather than a schema problem
until then.

The other signal is per-ingredient substitution: somebody wanting the catalog to know that their
lasagne is made with a different mince than the default one. That is composition proper, and it
gets ADR-NNN and a `food_component` table rather than a change here.
