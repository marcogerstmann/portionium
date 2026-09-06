---
id: ADR-001
title: 'SQLite instead of PostgreSQL for a small shared instance'
status: Accepted
date: 2026-09-06
---

## Context

Portionium is a food logging app for a handful of people sharing one instance. The realistic
shape of the load is a few users, each writing a small number of rows a day, mostly in bursts
around meals, with reads dominated by "today" and "the last few weeks". There is no multi
tenant story, no analytics workload, and no growth plan that assumes thousands of users.

Against that, a database server is a second thing to run, back up, upgrade, secure and pay
for. It also drags in connection pooling, a network hop, and a class of failure (the database
is up but unreachable) that a local file simply does not have. The application is a single
Node process, so there is no cluster that needs a shared database to coordinate.

The counter pressure is real: SQLite serialises writes. One writer at a time, database wide.
If that limit is the wrong trade, it is much cheaper to discover it now than after the schema
and the repositories have grown around it.

## Decision

Persistence is a single SQLite file, accessed through better-sqlite3 and Drizzle ORM, with
`journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000` and `synchronous = NORMAL`
set on every connection.

## Consequences

Easier:

- Deployment is a process and a file. Backup is a file copy, restore is a file copy back.
- Tests run against the real engine, not a stand in. A fresh database is a temp directory, so
  test isolation costs nothing and needs no container.
- Reads are a function call, not a network round trip, which removes the usual reason to batch
  queries defensively.
- No connection pool, no pool exhaustion, no idle timeout tuning.

Harder, and accepted deliberately:

- **One writer at a time.** WAL lets readers run concurrently with the writer, but writes
  serialise across the whole database, not per table or per row. With `busy_timeout = 5000` a
  second writer waits up to five seconds and then fails with SQLITE_BUSY. At the expected
  handful of concurrent users with sub millisecond writes this is invisible. It stops being
  invisible somewhere around sustained tens of writes per second, or any single transaction
  that holds the write lock for hundreds of milliseconds.
- **`synchronous = NORMAL` trades durability for throughput.** In WAL mode this can lose the
  most recent transactions on an OS crash or power loss. It cannot corrupt the database. For a
  meal log that is the right trade; it would not be for anything financial.
- **The database is tied to one machine.** Horizontal scaling of the API is off the table
  while this holds, because two processes on two machines cannot share the file.
- **No down migrations.** See the rollback note in AGENTS.md: recovery is restore from backup,
  not a reverse migration.
- Some SQL is unavailable or weaker than in PostgreSQL: no native `jsonb` operators, limited
  `ALTER TABLE`, no partial index features we might later want, weaker type affinity.

## Options considered

**PostgreSQL, self hosted.** The obvious default, and genuinely better at concurrent writes,
richer types and real online schema changes. Rejected because every one of those advantages
addresses a problem this instance does not have, while the costs (a second process to run,
patch and back up, plus pooling and network failure modes) are paid every day from day one.

**PostgreSQL, hosted (Supabase, Neon, or an equivalent managed offering).** Removes the
operational burden that sinks the self hosted option, and adds point in time recovery for
free. Rejected because it reintroduces a network dependency for what is otherwise a wholly
local app, adds a recurring cost and an external account to a project that is deliberately
self contained, and puts personal food and weight data on someone else's infrastructure.

**A document store or a plain JSON file.** Rejected in opposite directions. A document store
is more operational weight than PostgreSQL for less relational value, and the data here is
plainly relational. A JSON file loses transactions, constraints and indexes, which is exactly
what we would end up rebuilding badly.

## What would make us revisit this

Any one of these is enough to reopen the decision:

- SQLITE_BUSY appears in the logs during normal use, rather than under an artificial load test.
- Sustained write volume passes roughly ten writes per second, or a single request routinely
  holds the write transaction longer than about 100 milliseconds.
- The instance needs to run as more than one process, or on more than one machine, whether for
  availability or for deployment without downtime.
- The user count leaves the "people who know each other" range, on the order of a few dozen.
- A feature genuinely needs something SQLite does not have, such as full text search across a
  large corpus, or concurrent background jobs writing while users write.

The migration path out is a schema translation plus a one off data copy. Keeping all query
building inside `api/src/db/` is what keeps that path from touching the rest of the codebase.
