---
id: ADR-005
title: 'No Redis, no metrics stack, structured logs only'
status: Accepted
date: 2026-09-09
---

## Context

This instance is reachable from the internet and serves a household: two people, a phone each, a
handful of writes a day and a few hundred reads. The deployment is one Node process, one SQLite
file and a reverse proxy, by design, see [ADR 001](./001-sqlite-over-postgresql.md).

Basic hardening belongs in the MVP rather than a later polish phase, and rate limiting is the part
of it that needs somewhere to keep a number. Asked in the abstract, the answer is Redis: shared
across processes, survives a restart, atomic increment already written. Reaching for it here would
double the number of things that have to be running for the app to answer a request, in order to
protect an app that has one process. The same question arrives from the other direction once a
limiter exists, because somebody wants to see how often it fires, and the reflex answer to that is
Prometheus, Grafana and an alertmanager beside them.

## Decision

Rate limit state lives in the memory of the process that enforces it: an integer and a timestamp
per key in a `Map`, in a fixed one minute window, in
[`api/src/domain/window-counter.ts`](../../api/src/domain/window-counter.ts). It is the same
primitive the login lockout uses, which is the second reason not to add a dependency for it. A
store introduced for one would be the wrong shape for the other, or both would move and the sign in
path would grow a network call. There is no Redis, no second database, and no metrics stack.

Observability is the structured logs the host already collects. Pino writes one JSON object per
line at `LOG_LEVEL`; Fastify gives every request an id and a child logger bound to it, so every
line a request produces carries the same `reqId`, and that id is in the body of every error
response. What a line may never carry is decided once, in
[`api/src/http/logging.ts`](../../api/src/http/logging.ts), rather than at the call sites, so it is
a rule every line already follows including the ones nobody has written yet.

[`GET /health`](../../api/src/http/routes/health.ts) is liveness and does not touch the database,
because a check failing on a held write lock would have the process killed for a condition that
clears itself. `GET /ready` is readiness and does. Neither carries a version, an uptime or any
configuration: the caller has no credential, and the detail goes to the log.

## Consequences

Nothing has to be operated: no connection to fail, no eviction policy, no second thing to back up,
no version to keep in step. And the question that actually gets asked, "what did this request do",
is one grep for one id. The costs:

- **Limits reset when the process restarts.** A caller being refused gets a fresh allowance by
  waiting for a deploy, and an attacker who can cause a crash gets one on demand. The window is a
  minute, so the reset buys a minute of traffic, and a restarting process is not serving anybody.
  It would matter if the limits were the only thing between an attacker and an expensive
  operation, which is why the login lockout is a separate, longer window.
- **The limit is per process**, so a second process doubles it.
- **There are no latency percentiles and no dashboard.** "What is the p99 on food search" is
  answerable only by extracting `responseTime` from log lines and sorting them, which is a script
  somebody writes on the afternoon they need it. The same goes for error rates, request volume and
  how often the limiter fires. This is the cost that will be felt first.
- **Retention is whatever the host gives.** Logs go to stdout, which is the container runtime's to
  rotate, so a question about a month ago may have no data behind it at all.

## Options considered

**Redis, or any shared store, for the counters.** Correct, and what this would use at a hundred
instances. Here it adds a process to run, a connection to fail, and a decision about whether a
Redis outage fails open or closed, all to make a one minute counter survive a restart that happens
on deploys.

**A SQLite table for the counters.** Rejected for now, and the first thing to try if memory stops
being enough: the file is already there, it survives a restart, and two processes could share it.
What it costs is a write on every request, including every read the API serves, against the same
file the request is about to read.

**A token bucket rather than a fixed window.** A fixed window lets a caller send up to twice the
limit across a boundary, which is the honest downside. A token bucket smooths that out for a second
field and a rate calculation per key. At 120 requests a minute the burst is not a threat to an
otherwise idle process, and the simpler counter is the one that can be read and believed.

**Prometheus and Grafana.** Three more things to run, secure and back up, and a scrape endpoint
publishing the internals of a personal health application to whoever finds it, so that two people
can look at a graph nobody opens. Request counts by status and a latency histogram are derivable
from the lines this process already writes. The same objection sinks Loki or an ELK stack, with
more memory.

**OpenTelemetry.** Rejected more firmly, because tracing answers a question this deployment cannot
ask. A trace earns its weight when a request crosses services and the interesting fact is which hop
was slow. Here a request has one hop, and the request id already ties together everything it did.
The one place it would earn its keep, a slow AI classification call, is a duration on one log line.

## What would make us revisit this

The SQLite table is the answer to the first two:

- **More than one process serves the API**, at which point a per process limit is not the
  documented limit, or **restarts stop being rare**, which turns "resets on restart" from a
  footnote into a way through.
- **The limits start being load bearing**, with a metered dependency behind an endpoint where
  exceeding a limit costs money rather than CPU.
- **More than a handful of users, or a second instance.** Past roughly ten active people the
  question changes from "what happened to this request" to "what is happening in general", which an
  aggregate answers and a log file does not. The first step is then a metrics endpoint behind
  authentication, not a tracing backend.
- **A request leaves this process.** A span around one AI classification call is a smaller change
  than adopting tracing.
