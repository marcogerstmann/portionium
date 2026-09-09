---
id: ADR-005
title: 'No Redis, no metrics stack, structured logs only'
status: Accepted
date: 2026-09-09
---

## Context

This instance is reachable from the internet, or at least from a shared network, and serves a
household. Two people, a phone each, a handful of writes a day and a few hundred reads. The
deployment is one Node process, one SQLite file and a reverse proxy, which is the whole of it
by design, see [ADR 001](./001-sqlite-over-postgresql.md).

Basic hardening belongs in the MVP rather than in a later polish phase, and rate limiting is
the part of it that needs somewhere to keep a number. The obvious place, once the question is
asked in the abstract, is Redis: it is what every article about rate limiting reaches for, it
is shared across processes, it survives a restart and it has the atomic increment already
written. Reaching for it here would double the number oƒf things that have to be running for
the app to answer a request, in order to protect an app that has one process.

The same question arrives again from the other direction. Once a limiter exists, somebody
wants to see how often it fires, and the reflex answer to that is Prometheus, a scrape
endpoint, a Grafana instance and an alertmanager beside them.

## Decision

Rate limit state lives in the memory of the process that enforces it. A counter is an integer
and a timestamp per key in a `Map`, in a fixed one minute window, in
[`api/src/domain/window-counter.ts`](../../api/src/domain/window-counter.ts). It is the same
primitive the login lockout already uses, which is the second reason not to add a dependency
for it: the store that would have been introduced for one of them would then be the wrong shape
for the other, or both would move and the sign in path would grow a network call.

There is no Redis, no memcached and no second database. There is no metrics stack either. What
this process knows about itself goes into its structured logs, which the reverse proxy and the
host already collect.

<!--
  OPS 2 extends this file with the observability half of the decision: what a log line carries,
  how a request is followed through one, and what is deliberately not measured. It belongs here
  rather than in its own ADR because it is the same trade made twice. Leave this placeholder
  until that story lands.
-->

## Consequences

**Limits reset when the process restarts.** This is the accepted limitation and it is worth
stating plainly rather than burying. A caller who is being refused can get a fresh allowance by
waiting for a deploy, and an attacker who can cause a crash can get one on demand. Neither
matters much at this size: the window is a minute, so the reset buys a minute of traffic, and a
process that is restarting is not serving anybody anyway. It would matter if the limits were
the only thing standing between an attacker and an expensive operation, which is why the login
lockout is a separate, longer window counted the same way and why sign in has its own stricter
bucket.

**The limit is per process, so a second process doubles it.** One process is the deployment, and
the day that stops being true is in the revisit list below rather than a surprise.

**Nothing to operate.** No connection to fail, no eviction policy to tune, no second thing to
back up, no version to keep in step with the app. The counters cannot get out of sync with
anything because there is nothing to sync with.

**A question about last Tuesday is answered by reading logs.** There is no dashboard and no
retained time series, so "how often did the limiter fire in September" is a grep rather than a
graph, and only over whatever log retention the host provides. For an instance with two users
that is the right amount of answer for the effort.

## Options considered

**Redis, or any shared store, for the counters.** Rejected. It is correct and it is what this
would use at a hundred instances. Here it adds a process to run, a connection to fail, a
failure mode to decide about, whether a Redis outage should fail open and serve unlimited
traffic or fail closed and refuse all of it, and a second thing in the deployment story. All of
that to make a one minute counter survive a restart that happens on deploys.

**A SQLite table for the counters.** Rejected for now, and it is the first thing to try if the
in-memory version stops being enough. The database file is already there, so it costs no new
infrastructure, and it would survive a restart and be shared by two processes. What it costs is
a write on every request, including every read the API serves, against the same file the
request is about to read. That is a real price for a property nothing currently needs. The two
counters, the rate limiter and the login lockout, would move together.

**A token bucket rather than a fixed window.** Rejected. A fixed window lets a caller send up to
twice the limit across a window boundary, which is the honest downside. A token bucket smooths
that out and costs a second field and a rate calculation per key. At 120 requests a minute the
burst is not a threat to a process that is otherwise idle, and the simpler counter is the one
that can be read and believed.

**A metrics stack.** Rejected. Prometheus, a scrape endpoint and Grafana is three more things to
run and secure, publishing an unauthenticated endpoint describing the internals of a personal
health application, so that two people can look at a graph nobody checks.

## What would make us revisit this

Any one of these, and the SQLite table is the answer to the first three:

- **More than one process serves the API.** A second worker, a rolling deploy that overlaps, or
  a horizontal scale, at which point a per process limit is not the documented limit.
- **Restarts stop being rare.** A crash loop, or a platform that recycles the process on a
  schedule, either of which turns "resets on restart" from a footnote into a way through.
- **The limits start being load bearing.** A paid or metered dependency behind an endpoint, an
  AI classification call being the obvious one, where exceeding a limit costs money rather than
  CPU.
- **More than a handful of users.** At that point somebody is asking questions the logs answer
  slowly, and a metrics stack starts paying for itself.
