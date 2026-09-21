---
id: ADR-004
title: 'Idempotency keys on all writes, and the retention window'
status: Accepted
date: 2026-09-09
---

## Context

The web client logs meals from a phone, often on a connection that drops mid request. When a
request times out the client cannot tell whether the server committed before the connection went,
so it retries from an outbox. A retry of a write that had in fact succeeded is a second write: a
meal logged twice, a weight recorded twice. This is not a corner case, it is what a mobile
connection does in its first week of real use, and it corrupts exactly the data the app exists to
keep.

The fix has to hold for every write, not for meals alone, because the outbox does not know which
endpoints it is retrying. And it has to hold when two copies of a request arrive together, which is
what a retry racing a slow original looks like from the server.

## Decision

Every `POST`, `PUT`, `PATCH` and `DELETE` on an authenticated route accepts an `Idempotency-Key`
header. The first request carrying a key runs, and its status and body are stored under that key
and the caller's user id. A later request with the same key and the same fingerprint, a hash of
method, URL and canonicalised body, is answered from the stored row without running. The same key
with a different fingerprint is refused with 422, because running it would make the key mean two
things.

Concurrency is settled by the database. The row is inserted before the handler runs, with no
response yet, and a unique index over `(user_id, key)` lets exactly one insert through. The copy
that lost finds a row with no response and is answered 409. There is no lock in the process and
nothing that resets when it restarts.

A request with no key runs every time it is sent, and public routes ignore the header: there is no
user to file a key under, and the only public write is the login, whose retry costs a session row
rather than a duplicate meal.

Keys are kept for `IDEMPOTENCY_RETENTION_HOURS`, 24 by default, purged hourly. A day is chosen from
the client's side: an outbox that lost signal in a tunnel retries within seconds, one reopened the
next morning within hours, and a day covers the phone left in a drawer overnight without keeping
every response longer than anybody would retry it. It is configurable because the number was
reasoned rather than measured. The implementation is
[`api/src/http/plugins/idempotency.ts`](../../api/src/http/plugins/idempotency.ts).

## Consequences

A client sending the header on every write can retry any of them, as often as it likes, and observe
exactly one effect. The outbox needs a key per queued request, kept across attempts, which is a
UUID and a column. Every keyed write then costs one insert before the handler and one update after
it, on a table that is trimmed daily and holds at most a few hundred rows here.

The costs:

- A stored response is a copy of what a user was told, kept for a day, **including a freshly minted
  API token**. That makes the table as sensitive as the log.
- A replay is only as faithful as what was stored: status, body and content type. A response header
  set by a handler is not, so a write whose meaning lives in a header cannot be made idempotent
  this way. Today no authenticated write sets one.
- The 409 requires a client to retry once more, which an outbox does anyway, and the hourly purge
  means a key can outlive its window by an hour. Neither matters: no client reuses a key on
  purpose.

## Options considered

**Client side deduplication only.** The client marks an entry as sent when it gets a response and
never resends it. The case that matters is the one where no response arrived: the request left, the
server committed, the connection dropped. The client has no information with which to deduplicate,
and no client side rule can manufacture it.

**Natural key uniqueness constraints**, a unique index on say `(user_id, logged_at, type)`. One
design per table, each arguing about what makes two rows the same, when two identical meals a
minute apart are legitimate. It turns a retry into an error the client has to recognise as success.
And it does nothing for updates and deletes, where the second attempt violates nothing and quietly
applies a stale change.

**Storing only that the key was seen, not the response.** Smaller row, no copy of anything
sensitive. The retry still has to be answered with something, and the only honest something is the
original response: a synthetic 200 with no body tells an outbox the write happened without telling
it what was created.

**Locking in the process.** A map of in-flight keys, checked before the handler. The unique index
does the same job with no code, survives a restart, and does not break the day this runs as two
processes.

## What would make us revisit this

A write whose response carries a header the client depends on. Then either the row grows a column
for headers, or that write documents itself as not replayable.

An outbox that retries after more than a day, which would show up as duplicate rows again and would
argue for a longer default rather than a different design.
