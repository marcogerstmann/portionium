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
written. Reaching for it here would double the number of things that have to be running for
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

There is no Redis, no memcached and no second database. There is no metrics stack either.

What this process knows about itself goes into its structured logs, which the host already
collects, and those logs are the whole of the observability story. Pino writes one JSON object
per line, at a level `LOG_LEVEL` sets. Fastify gives every request an id and a child logger bound
to it, so the two lines a request writes and every application line in between carry the same
`reqId`, and the finished line repeats the method and the path beside the status and the duration.
That id is also in the body of every error response, which is what turns "it broke yesterday
afternoon" into one grep.

What a line may never carry is decided in
[`api/src/http/logging.ts`](../../api/src/http/logging.ts) rather than at the call sites:
passwords, tokens, addresses in full, and the content of any prompt sent to a model. A rule
applied where the line is written is a rule every line already follows, including the ones
nobody has written yet. An address is masked rather than dropped, because a burst of failures
against one domain is the shape worth noticing and the local part is the half that records who
holds an account here.

Two probes, for the two things an orchestrator does with the answer.
[`GET /health`](../../api/src/http/routes/health.ts) is liveness and does not touch the
database, because a check that fails on a held write lock would have the process killed for a
condition that clears itself. `GET /ready` is readiness and does, answering 503 when the file
does not respond or its schema is behind the build. Neither carries a version, a commit, an
uptime or any configuration: the caller has no credential, and the detail goes to the log, where
the person reading it is entitled to it.

An uncaught exception or an unhandled rejection is logged at fatal and ends the process. Nothing
is drained first, because a graceful shutdown in a state nothing can reason about is how a
container hangs instead of restarting.

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

**There are no latency percentiles, and no dashboard to put them on.** Nothing aggregates. A
question like "what is the p99 on the food search" is answerable only by extracting
`responseTime` from the lines of a log file and sorting them, which is a script somebody writes
on the afternoon they need it rather than a graph that is already there. The same goes for error
rates, request volume and how often the limiter fires. This is the accepted cost and it is the
one that will be felt first.

**Retention is whatever the host gives.** The logs go to stdout, which is the container runtime's
to rotate. Nobody here decided how long they live, which means a question about a month ago may
have no data behind it at all.

**A question about last Tuesday is answered by reading logs.** "How often did the limiter fire in
September" is a grep rather than a graph, and "what did this request do" is a grep for one id.
For an instance with two users that is the right amount of answer for the effort, and it is worth
noticing that the second question is the one that actually gets asked.

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

**Prometheus and Grafana.** Rejected. A scrape endpoint, a time series database and a dashboard
is three more things to run, secure and back up, and the endpoint itself publishes the internals
of a personal health application to whoever finds it, so that two people can look at a graph
nobody opens. The metrics it would carry, request counts by status and a latency histogram, are
derivable from the log lines this process already writes, and at a handful of requests a minute
the derivation is a one line script rather than an infrastructure decision.

**OpenTelemetry.** Rejected, and rejected more firmly than Prometheus, because tracing answers a
question this deployment cannot ask. A trace is worth its weight when a request crosses services
and the interesting fact is which hop was slow. Here a request has one hop: this process, and a
SQLite file in the same container. The request id already ties everything one request did
together, which is the whole of what a trace id would buy. What it would cost is an SDK in the
hot path, an auto instrumentation layer with its own opinions about every library it patches, and
a collector to run beside the app. The one place it would genuinely earn its keep is a slow AI
classification call, and that is a duration on one log line.

**Logging to a file, or to a log aggregator.** Rejected. stdout is what the container runtime
already collects and what `docker logs` already reads, so writing a file means deciding about
rotation, disk and permissions in order to end up somewhere less accessible. An aggregator,
Loki or an ELK stack, is the Prometheus answer again with more memory.

## What would make us revisit this

Any one of these, and the SQLite table is the answer to the first three:

- **More than one process serves the API.** A second worker, a rolling deploy that overlaps, or
  a horizontal scale, at which point a per process limit is not the documented limit.
- **Restarts stop being rare.** A crash loop, or a platform that recycles the process on a
  schedule, either of which turns "resets on restart" from a footnote into a way through.
- **The limits start being load bearing.** A paid or metered dependency behind an endpoint, an
  AI classification call being the obvious one, where exceeding a limit costs money rather than
  CPU.
- **More than a handful of users, or a second instance.** This is the concrete trigger for the
  observability half, and either condition is enough. Past roughly ten active people the
  questions change from "what happened to this request" to "what is happening in general", which
  is the question an aggregate answers and a log file does not. A second instance means the logs
  are in two places and a p99 cannot be read off either of them. The first step then is a metrics
  endpoint behind authentication and a scraper, not a tracing backend: percentiles and error
  rates are what is missing, and the request id already does what a trace id would.
- **A request leaves this process.** An AI classification call over the network is the first one,
  and it is the point at which a duration on one log line stops being enough to say where the
  time went. A span around that one call is a smaller change than adopting tracing, and is what
  to reach for rather than instrumenting everything.
