---
id: ADR-003
title: 'Multi-user from the start, and 404 rather than 403 for foreign resources'
status: Accepted
date: 2026-09-09
---

## Context

This instance serves a household: two accounts, maybe three, with no prospect of a tenth. That is a
strong argument for building it single user, because every `user_id` column, session lookup and
scope check is code that can be got wrong. The argument against is the retrofit. Making a single
user application multi-user later is a migration of every table, every query and every handler at
once, run against data with no owner recorded, and the day one query is missed is the day one
account reads another's food diary. There is no partial version of that change and no way to test
the half that has not been done.

The second question is what a caller is told when they ask for a row that exists and is not theirs.
The obvious answer is 403, and the obvious answer leaks. Ids here are UUIDv7, which sort by
creation time, so a caller holding one of their own knows roughly where their neighbours sit in the
sequence. A 403 meaning "this exists but is not yours", beside a 404 meaning "this does not exist",
answers "which ids are real" for anybody willing to send requests.

## Decision

Every user owned table carries `user_id` from its first migration, and every repository read takes
a `userId` and filters on it. No query in `api/src/db/` can return a row without being told whose
row it may return.

Identity is established in exactly one place,
[`api/src/http/plugins/auth.ts`](../../api/src/http/plugins/auth.ts), which resolves a session
cookie or bearer token into a frozen context carrying `userId`, `role` and `scopes`. Routes are
authenticated by default: one that names neither a scope nor `public` stops the server booting.

A request for another user's row is answered **404**, with the same problem type, title and detail
as a request for a row that never existed. This is not a special case in the handlers. The
repository filters by owner, the row does not come back, and the handler raises
`ResourceNotFoundError` because as far as it can tell there is nothing there. No branch anywhere
knows the difference, which is what makes the two answers identical rather than merely similar.

403 is kept for the one case where it says nothing: `InsufficientScopeError`, when a known caller
lacks a route's scope. That is a statement about the caller, not about which rows exist.

## Consequences

Every read costs a `userId` argument and every table costs a column, in an application whose users
fit on one hand. That is the price, paid on the first day rather than during a migration nobody can
test.

A client cannot tell "this does not exist" from "this is not yours". That is the point and it is a
real cost: an administrator debugging a support request gets 404 for a row they can see in the
database, and a revoked share link looks like one that was never valid. The distinction is in the
server log, under the request id every problem response carries.

Scopes are derived from the stored role today, so the indirection buys nothing yet. It is there so
that the first credential carrying less than its owner does, an API token, is a change to one
function.

## Options considered

**Single user now, retrofit later.** All-or-nothing, run against production data with no owner
recorded, failure mode one account reading another's.

**403 for a resource belonging to another user.** The honest status code, answering a question the
caller is not entitled to ask. With time sortable ids the enumeration it enables is cheap rather
than theoretical.

**Ownership checked in the handlers rather than the repositories.** Works until one handler
forgets, and the forgetting is invisible: the endpoint returns data and the tests pass. A
repository that cannot be called without a `userId` moves the mistake to the type checker.

**Row level security in the database.** SQLite has none, and building it out of triggers would put
the rule in the one place this repository has no tests around. Revisit with PostgreSQL, see
[ADR 001](./001-sqlite-over-postgresql.md).

## What would make us revisit this

An endpoint that genuinely has to distinguish the two 404s for a person rather than a machine, such
as a share link that should say "the owner revoked this". That is a narrower feature than a general
403 and should be built as one, on a resource whose ids are already public.

Scopes outliving their usefulness. If a year from now every route still requires `account` and
nothing has needed `admin`, the mapping is ceremony and should collapse back into a role check.
