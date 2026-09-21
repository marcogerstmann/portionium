# Architecture decision records

Short records of decisions that are expensive to reverse. One file per decision, numbered in order,
one page each. A decision that changes gets a new record superseding the old one, and the old one
stays in place with its status updated rather than being edited into agreement. A record may still
gain a pointer to a later one that narrows it without reversing it, which is what
[006](./006-single-foods-table.md) and [007](./007-append-only-classification-log.md) carry towards
[011](./011-an-entry-is-a-colour.md).

Copy [`template.md`](./template.md) to `NNN-short-title.md` and add a row below. `pnpm adr` checks
that this table matches the records and that the numbering has no gaps, and CI runs it, so a record
cannot be added, renamed or removed without the index following. A gap in the numbering is the
cheap signal that a record was deleted rather than superseded.

A story with an ADR acceptance criterion is not done until its ADR exists.

| ADR                                            | Title                                                                                      | Status   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------ | -------- |
| [001](./001-sqlite-over-postgresql.md)         | SQLite instead of PostgreSQL for a small shared instance                                   | Accepted |
| [002](./002-local-day-boundaries.md)           | Local day boundaries, per-user timezone, and handling of backdated edits                   | Accepted |
| [003](./003-multi-user-authorization.md)       | Multi-user from the start, and 404 rather than 403 for foreign resources                   | Accepted |
| [004](./004-idempotency-keys.md)               | Idempotency keys on all writes, and the retention window                                   | Accepted |
| [005](./005-no-redis-no-metrics-stack.md)      | No Redis, no metrics stack, structured logs only                                           | Accepted |
| [006](./006-single-foods-table.md)             | Single foods table for ingredients and dishes, no composition                              | Accepted |
| [007](./007-append-only-classification-log.md) | Append-only classification log with a resolution rule instead of a mutable category column | Accepted |
| [008](./008-weight-trend-smoothing.md)         | Weight trend smoothing algorithm                                                           | Accepted |
| [009](./009-hosting-and-deployment.md)         | Hosting model and deployment target                                                        | Accepted |
| [010](./010-pwa-and-offline-outbox.md)         | PWA instead of native, and one-directional outbox instead of bidirectional sync            | Accepted |
| [011](./011-an-entry-is-a-colour.md)           | An entry is a colour, stamped at write, not a projection of its food                       | Accepted |
| [012](./012-ai-as-a-degradable-dependency.md)  | AI classification as a degradable dependency                                               | Accepted |
