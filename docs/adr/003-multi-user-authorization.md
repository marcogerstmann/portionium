---
id: ADR-003
title: 'Multi-user from the start, and 404 rather than 403 for foreign resources'
status: Accepted
date: 2026-09-09
---

## Context

This instance serves a household. Two accounts, maybe three, on one small server, and no
prospect of a tenth. That is a strong argument for building it single user: one implicit owner,
no `user_id` columns, no session to resolve into an identity, no scope to check. It is less code
in every file, and the code it removes is the code most likely to be got wrong.

The argument against is what the retrofit looks like. Making a single user application
multi-user later is not a feature, it is a migration of every table, every query and every
handler at once, run against data that already exists and has no owner recorded. Every row
written before the change has to be assigned to somebody by a script that guesses, every query
has to grow a filter, and the day one of them is missed is the day one account reads another's
food diary. There is no partial version of that change and no way to test the half that has not
been done yet.

The second question is what an authenticated caller should be told when they ask for a row that
exists and is not theirs. The obvious answer is 403: the request was understood, the caller is
known, and they may not have it. The obvious answer leaks. Ids in this system are UUIDv7, which
sort by creation time, so a caller who holds one of their own ids knows roughly where their
neighbours sit in the sequence. A 403 that means "this exists but is not yours", next to a 404
that means "this does not exist", answers the question "which ids are real" for anybody willing
to send requests, and it answers it about rows they will never be allowed to read.

## Decision

Every user owned table carries `user_id` from its first migration. Every repository read takes a
`userId` parameter and filters on it. There is no query in `api/src/db/` that can return a row
without being told whose row it may return.

Identity is established in exactly one place,
[`api/src/http/plugins/auth.ts`](../../api/src/http/plugins/auth.ts). It resolves a session
cookie or a bearer token into a frozen request context carrying `userId`, `role` and `scopes`,
and that context is the only supported way for a handler to learn who is calling. Routes are
authenticated by default: a route names the scope it needs or says `public` in so many words,
and one that says neither stops the server from booting rather than answering.

A request for a row that belongs to another user is answered **404**, with the same problem
type, title and detail as a request for a row that was never there. This is not a special case
in the handlers. The repository filters by owner, the row does not come back, and the handler
raises `ResourceNotFoundError` because as far as it can tell there is nothing there. There is no
branch anywhere that knows the difference, which is what makes the two answers identical rather
than merely similar today.

403 is kept for the case where it says nothing: `InsufficientScopeError`, raised when a known
caller lacks the scope a route requires. That is a statement about the caller, not about which
rows exist, so there is nothing to leak by making it.

## Consequences

Every read costs a `userId` argument and every table costs a column, in an application whose
users could be counted on one hand. That is the price, paid on the first day rather than during
a migration nobody can test.

A client cannot tell "this does not exist" from "this is not yours". That is the point, and it
is also a real cost: an administrator debugging a support request gets 404 for a row they can
see in the database, and a shared link that stops working looks the same as one that was never
valid. The server log has the distinction, under the request id every problem response carries,
which is where somebody entitled to know can find it.

A user id that arrives in a request body, a query string or a path segment is not an identity
and is never read as one. Request schemas are strict, so a `userId` a client sends is a 400
rather than a value, and a test in `api/test/http/authorization.test.ts` greps the adapters for
a handler reading one out of an incoming payload.

Scopes are derived from the stored role today, which means the indirection buys nothing yet. It
is there so that routes name capabilities rather than roles, and so that the first credential
that carries less than its owner does, an API token, is a change to one function.

## Options considered

**Single user now, retrofit later.** Rejected above. The retrofit is all-or-nothing, runs
against production data with no owner recorded, and its failure mode is one account reading
another's.

**403 for a resource belonging to another user.** Rejected. It is the honest status code and it
answers a question the caller is not entitled to ask. With time sortable ids, the enumeration it
enables is cheap rather than theoretical.

**Ownership checked in the handlers rather than the repositories.** Rejected. It works until
one handler forgets, and the forgetting is invisible: the endpoint returns data and the tests
pass. A repository that cannot be called without a `userId` moves the mistake from runtime to
the type checker.

**Row level security in the database.** SQLite has none, and building it out of triggers would
put the rule in the one place this repository has no tests around. Revisit with PostgreSQL, see
[ADR 001](./001-sqlite-over-postgresql.md).

## What would make us revisit this

An endpoint that genuinely has to distinguish the two 404s for a person rather than a machine:
a share link that should say "the owner revoked this" instead of "no such page". That is a
narrower feature than a general 403, and it should be built as one, on a resource whose ids are
already public.

The other signal is scopes outliving their usefulness. If a year from now every route still
requires `account` and nothing has ever needed `admin`, the mapping is ceremony and should
collapse back into a role check.
