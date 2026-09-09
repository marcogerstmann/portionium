# Architecture decision records

Short records of decisions that are expensive to reverse. One file per decision, numbered in order,
never edited after acceptance. A decision that changes gets a new ADR that supersedes the old one,
and the old one stays in place with its status updated.

Copy [`template.md`](./template.md) to `NNN-short-title.md` and add a row below.

A story with an ADR acceptance criterion is not done until its ADR exists.

| ADR                                      | Title                                                                    | Status   |
| ---------------------------------------- | ------------------------------------------------------------------------ | -------- |
| [001](./001-sqlite-over-postgresql.md)   | SQLite instead of PostgreSQL for a small shared instance                 | Accepted |
| [002](./002-local-day-boundaries.md)     | Local day boundaries, per-user timezone, and handling of backdated edits | Accepted |
| [003](./003-multi-user-authorization.md) | Multi-user from the start, and 404 rather than 403 for foreign resources | Accepted |
| [004](./004-idempotency-keys.md)         | Idempotency keys on all writes, and the retention window                 | Accepted |
