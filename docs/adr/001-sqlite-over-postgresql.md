---
id: ADR-001
title: 'SQLite instead of PostgreSQL for a small shared instance'
status: Accepted
date: 2026-09-06
---

## Context

Portionium serves a handful of people on one instance: a few users, a few rows each a day, reads
dominated by "today" and "the last few weeks". No multi tenancy, no analytics workload, no growth
plan that assumes thousands of users, and one Node process, so nothing needs a shared database to
coordinate.

A database server, against that, is a second thing to run, back up, upgrade, secure and pay for,
plus pooling, a network hop, and a failure mode (up but unreachable) that a local file does not
have. The counter pressure is that SQLite serialises writes, database wide, and if that is the
wrong trade it is cheaper to find out now than after the repositories have grown around it.

## Decision

One SQLite file, through better-sqlite3 and Drizzle ORM, with `journal_mode = WAL`,
`foreign_keys = ON`, `busy_timeout = 5000` and `synchronous = NORMAL` on every connection.

## Consequences

Deployment is a process and a file, backup is a file copy, tests run against the real engine in a
temp directory, and a read is a function call rather than a round trip. Against that:

- **One writer at a time.** WAL lets readers run alongside the writer, but writes serialise across
  the whole database. A second writer waits five seconds and then fails with SQLITE_BUSY. Invisible
  at sub-millisecond writes from a few users; not invisible around sustained tens of writes per
  second.
- **`synchronous = NORMAL` can lose the most recent transactions** on an OS crash or power loss. It
  cannot corrupt the file. Right for a meal log, wrong for anything financial.
- **One machine**, so horizontal scaling of the API is off the table, and no down migrations:
  recovery is restore from backup.
- Weaker SQL than PostgreSQL's: no `jsonb` operators, limited `ALTER TABLE`, weaker type affinity.

## Options considered

**PostgreSQL, self hosted.** Genuinely better at concurrent writes, richer types and online schema
changes. Every one of those advantages addresses a problem this instance does not have, while its
costs, a second process to run, patch and back up, plus pooling and network failure modes, are paid
every day from day one.

**PostgreSQL, hosted (Supabase, Neon or equivalent).** Removes that operational burden and adds
point in time recovery for free. Rejected because it puts a network dependency, a recurring cost
and an external account into an otherwise self contained project, and personal food and weight data
onto someone else's infrastructure.

**A document store, or a plain JSON file.** Rejected in opposite directions: a document store is
more operational weight than PostgreSQL for less relational value, on data that is plainly
relational, and a JSON file loses the transactions, constraints and indexes we would then rebuild
badly.

## What would make us revisit this

- SQLITE_BUSY in the logs during normal use rather than under an artificial load test.
- Sustained writes past roughly ten per second, or a request routinely holding the write
  transaction longer than about 100 ms.
- A need to run as more than one process, or on more than one machine.
- A user count past the "people who know each other" range, on the order of a few dozen.

The way out is a schema translation and a one off data copy. Keeping all query building inside
`api/src/db/` is what keeps that path from touching the rest of the codebase.
