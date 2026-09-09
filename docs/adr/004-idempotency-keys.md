---
id: ADR-004
title: 'Idempotency keys on all writes, and the retention window'
status: Accepted
date: 2026-09-09
---

## Context

The web client logs meals from a phone, often on a connection that drops mid request. When a
request times out the client cannot tell whether the server committed it before the connection
went, so it retries from an outbox. A retry of a write that had in fact succeeded is a second
write: a meal logged twice, a weight recorded twice. This is not a corner case, it is what a
mobile connection does in its first week of real use, and it corrupts exactly the data the app
exists to keep.

The fix has to hold for every write, not for meals alone, because the outbox does not know which
endpoints it is retrying. And it has to hold when two copies of a request arrive together, which
is what a retry racing a slow original looks like from the server.

## Decision

Every `POST`, `PUT`, `PATCH` and `DELETE` on an authenticated route accepts an `Idempotency-Key`
header. The first request carrying a key runs and its response is stored, status and body,
under that key and the caller's user id. A later request with the same key and the same
fingerprint, a hash of method, URL and canonicalised body, is answered from the stored row
without running. The same key with a different fingerprint is refused with 422, because the
stored answer belongs to another request and running this one would make the key mean two
things.

Concurrency is settled by the database. The row is inserted before the handler runs, with no
response yet, and a unique index over `(user_id, key)` lets exactly one insert through. The
copy that lost finds the row with no response and is answered 409, to retry after the first
has finished. There is no lock in the process and nothing that resets when it restarts.

Keys are kept for `IDEMPOTENCY_RETENTION_HOURS`, 24 by default, and purged by an hourly job.
A request with no key runs every time it is sent. Public routes ignore the header: there is no
user to file a key under, and the only public write is the login, whose retry costs a session
row rather than a duplicate meal.

The implementation is [`api/src/http/plugins/idempotency.ts`](../../api/src/http/plugins/idempotency.ts).

## Consequences

A client that sends the header on every write can retry any of them, as often as it likes, and
observe exactly one effect. The web outbox needs to generate a key per queued request and keep
it across attempts, which is a UUID and a column.

Every keyed write costs one insert before the handler and one update after it. The table grows
by one row per keyed write and is trimmed daily, so on this instance it holds at most a few
hundred rows.

A stored response is a copy of what a user was told, kept for a day, including a freshly minted
API token. That is deliberate, see below, and it means the table is as sensitive as the log.

A replay is only as faithful as what was stored: status, body and content type. A response
header set by a handler is not stored, so a write whose meaning lives in a header cannot be
made idempotent this way. Today no authenticated write sets one; the login's cookie is the one
that does, and the login is public.

The 409 answer requires a client to retry once more, which an outbox does anyway.

## Options considered

**Client side deduplication only.** The client marks an outbox entry as sent when it gets a
response and never resends it. Rejected, because the case that matters is the one where no
response arrived: the request left, the server committed, the connection dropped. The client
has no information with which to deduplicate, and no client side rule can manufacture it. Only
the server knows whether the first attempt landed.

**Natural key uniqueness constraints.** A unique index on, say, `(user_id, logged_at, type)`
for meals, so that a duplicate insert fails. Rejected for three reasons. It is one design per
table, and each has to argue about what makes two rows the same, when two identical meals a
minute apart are legitimate. It turns the retry into an error the client then has to recognise
and translate into success. And it does nothing for updates and deletes, where the second
attempt does not violate anything and quietly applies a stale change. A key chosen by the
client says what the client actually means, which is "this is the same request", not "this
looks like the same data".

**Storing only that the key was seen, not the response.** Smaller row, no copy of anything
sensitive. Rejected, because the retry then has to be answered with something, and the only
honest something is the original response. A synthetic 200 with no body tells an outbox the
write happened without telling it what was created, so the client cannot show the meal it just
logged or link to the token it just minted. Storing the body makes the replay indistinguishable
from the original, which is what an outbox that does not know it is retrying needs.

**Locking in the process.** A map of in flight keys, checked before the handler. Rejected,
because the unique index does the same job with no code and survives a restart, and because a
map in one process is the first thing that breaks if this ever runs as two.

## The retention window

Twenty four hours is chosen from the client's side. An outbox on a phone that lost signal in a
tunnel retries within seconds; one that was closed and reopened the next morning retries within
hours. A day covers the phone that was left in a drawer overnight and stops short of keeping a
copy of every response for longer than anybody would retry it. It is configurable because a
deployment with a different client, a script that batches nightly, may need a different answer,
and because the number was chosen by reasoning rather than measured.

The purge runs hourly rather than on a precise schedule, so a key lives up to an hour past the
window. A reused key inside that hour is answered from the table rather than run, which is
harmless: no client reuses a key on purpose.

## What would make us revisit this

A write whose response carries a header the client depends on. Then either the row grows a
column for headers or that write documents itself as not replayable.

A second API process against the same file, which the design already survives, or a move to
PostgreSQL, where the same unique index does the same job and nothing here changes.

An outbox that retries after more than a day, which would show up as duplicate rows again and
would be an argument for a longer default rather than a different design.
