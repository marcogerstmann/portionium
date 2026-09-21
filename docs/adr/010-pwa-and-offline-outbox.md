---
id: ADR-010
title: 'PWA instead of native, and one-directional outbox instead of bidirectional sync'
status: Accepted
date: 2026-09-13
---

## Context

The product's claim is that logging a meal takes a few seconds and happens several times a day.
That claim is made while somebody is standing in a canteen, on a train, or in a kitchen in a
basement flat, which is to say at the moment the network is least likely to be there. An app that
needs a round trip before it will admit a meal was logged is abandoned in week three, and the
abandonment looks like a product failure rather than a connectivity one.

Two decisions follow, recorded together because the second is only forced by the first: what the
client is, and what it does about the network. The constraints are already on the table. The
instance serves two people on one small always-on container
([ADR 009](./009-hosting-and-deployment.md)), there is one developer, every write already accepts
an `Idempotency-Key` ([ADR 004](./004-idempotency-keys.md)), meals accept a client-minted id, and
local dates are derived from an instant and a boundary hour
([ADR 002](./002-local-day-boundaries.md)), so a client can derive the same date the server will.

## Decision

The client is an **installable PWA**, and it handles the network with a **one-directional outbox**:
writes are appended to an IndexedDB queue and replayed at the server, reads are served from an
IndexedDB cache and then replaced by whatever the server says. Concretely, in `web/src/db.ts` and
`web/src/outbox.ts`:

- A write is durable before any request is made, and the caller never waits on the network. The
  screen renders an optimistic copy of the row the server will hold.
- Every entry carries a UUIDv7 minted once at enqueue. It is the `Idempotency-Key` on every
  attempt, and because a UUIDv7 sorts by the moment it was made, it is also the queue order.
- A meal additionally carries a client-minted entity id in its body, so a retry hands the server
  the same meal rather than asking for a second one.
- The server is the source of truth for every read. An optimistic copy is overwritten by the
  server's version as soon as the entry drains. Nothing on the device ever wins an argument.

The direction is the decision. Rows flow device to server as writes and server to device as reads,
and there is no third path where a device's copy of a row the server also changed has to be
reconciled with it.

## Consequences

Logging works with no network at all, including on a cold launch, which is what the product claims.
A meal logged in a basement is on the server by the time the phone next sees a mast, and it is
there exactly once. One person on one device never sees a conflict, because there is nothing to
conflict with, and that is the case that actually occurs. There is no merge logic, no vector clock
and no last-writer-wins rule to explain: the entire concurrency story is one Web Lock so two open
tabs do not both send the same entry, and even that is an optimisation, because the idempotency key
already makes a double send harmless.

The costs are real and accepted:

- **A second device shows stale reads until it refreshes.** A meal logged on the phone does not
  appear in an already-open desktop tab until something makes it re-fetch. There is no push, no
  subscription and no invalidation.
- **An edit made on two devices while both are offline resolves as last writer wins, by accident
  rather than by design.** Both outboxes drain, both writes land, and nothing detects that the two
  disagreed. Acceptable only because the window is small and the data is a personal food diary
  rather than a shared document.
- **A permanently rejected write has to be surfaced rather than retried.** A 422 cannot be fixed by
  sending the same bytes again, so the entry leaves the retry loop and waits for a person, which is
  a state the UI has to have a place for.
- **The PWA ceiling is accepted**: no Health Connect, no home screen widget, no OS-scheduled
  background work.

## Options considered

**A full sync engine with conflict resolution.** A change log on both sides, sync tokens,
tombstones for deletes, and a rule for what happens when the same row changed in both places.
Rejected as the largest thing in the project by a wide margin, built for a problem this instance
does not have, and its failure mode is worse than its cost: a sync engine that is subtly wrong
loses or duplicates data silently and is discovered weeks later, in a diary where nobody can
reconstruct what was true. A one-directional outbox that is wrong fails loudly, at the one point
where a request is sent.

**Online-only, with a spinner and a retry button.** Breaks the product's central claim at exactly
the moment it is being made; the canteen with no signal is not an edge case in a food diary, it is
lunch. A retry button also pushes the duplicate problem onto the user, who taps it twice and gets
two meals. The idempotency key that prevents that has to exist either way, and once it does, the
remaining distance to an outbox is a queue table and a drain loop. This option is not simpler in
the place that matters: it is simpler in the client and moves the complexity into the user's hands.

**A native Android client.** The option with a genuine cost rather than a straw man. Given up:
**Health Connect**, so a smart scale that already writes there would populate this app with no
entry at all, and weight now stays typed in by hand; **home screen widgets**, a one-tap "log
breakfast" tile being the shortest possible version of the core interaction; and **WorkManager**,
guaranteed background execution that survives the app being closed, where the outbox drains only
when the app is open or Background Sync wakes it. What buys that back is one codebase, one language
and one deployment for one developer, installation being a URL with no store listing or signing key
to keep for a decade, and the same client serving the desktop, where a good part of the actual
usage is. This is a decision that could reverse, and it is recorded so that reversing it is a
decision rather than a drift.

**Service worker owns the outbox**, so Background Sync can send while no page is open. It
duplicates the request layer and the schemas into a second runtime to buy one trigger. The service
worker's job here is the app shell and waking the page, and `web/public/sw-drain.js` does that and
nothing more.

## What would make us revisit this

- **A third device, or two people sharing one account.** The stale-read window stops being
  invisible the moment two clients routinely look at the same day at the same time.
- **A second device becoming normal for one person**, logging on a phone and reviewing on a laptop
  that stays open, which moves the lag from unobservable to annoying.
- **Health Connect becoming the way weight actually gets recorded**, if a smart scale enters the
  picture. The most likely trigger of the four.
- **Drains observed to be delayed for hours**, which would mean the app is closed after logging and
  not reopened, and would justify moving the drain into the service worker.

If multi-device does become real, the shape of the work is known and deliberately not built: a
monotonic **change log** per user, **tombstones** so a delete is something a client can learn about,
and **sync tokens** so a client can resume where it stopped. That is the sync engine rejected above,
and it should be adopted as one deliberate piece of work rather than arrived at one field at a time.
