---
id: ADR-010
title: 'PWA instead of native, and one-directional outbox instead of bidirectional sync'
status: Accepted
date: 2026-09-13
---

## Context

The product's claim is that logging a meal takes a few seconds and happens several times a day.
That claim is made at the moment somebody is standing in a canteen, on a train, or in a kitchen
in a basement flat, which is to say at the moment the network is least likely to be there. An
app that needs a round trip before it will admit a meal was logged is an app that is abandoned
in week three, and the abandonment will look like a product failure rather than a connectivity
one.

Two decisions follow from that and they are recorded together because the second is only
forced by the first. What is the client, and what does the client do about the network.

The constraints they are decided under are all already on the table. The instance serves two
people, on one small always-on container ([ADR 009](./009-hosting-and-deployment.md)). There is
one developer. Every write already accepts an `Idempotency-Key` and answers a retry with the
first attempt's response ([ADR 004](./004-idempotency-keys.md)). Meals already accept a
client-minted id, so a device can name a row before the server has ever seen it. Local dates are
derived from an instant and a per-user boundary hour ([ADR 002](./002-local-day-boundaries.md)),
which means a client can derive the same date the server will.

## Decision

The client is an **installable PWA**, and it handles the network with a **one-directional
outbox**: writes are appended to an IndexedDB queue and replayed at the server, reads are served
from an IndexedDB cache and then replaced by whatever the server says.

Concretely, in `web/src/db.ts` and `web/src/outbox.ts`:

- A write is durable before any request is made, and the caller never waits on the network. The
  screen renders an optimistic copy of the row the server will hold.
- Every entry carries a UUIDv7 minted once at enqueue. It is the `Idempotency-Key` on every
  attempt, and because a UUIDv7 sorts by the moment it was made, it is also the queue order.
- A meal additionally carries a client-minted entity id in its body, so a retry hands the server
  the same meal rather than asking for a second one.
- The server is the source of truth for every read. An optimistic copy is overwritten by the
  server's version as soon as the entry drains. Nothing on the device ever wins an argument.

The direction is the decision. Rows flow device to server as writes and server to device as
reads, and there is no third path where the device's copy of a row the server also changed has
to be reconciled with it.

## Consequences

Logging works with no network at all, including on a cold launch, which is what the product
claims. A meal logged in a basement is on the server by the time the phone next sees a mast,
and it is on the server exactly once.

One person on one device never sees a conflict, because there is nothing to conflict with. That
is the case this is designed for and it is the case that actually occurs.

There is no merge logic, no vector clock, no last-writer-wins rule to explain to anybody, and no
class of bug where two devices argue. The entire concurrency story is one Web Lock so that two
open tabs do not both send the same entry, and even that is an optimisation rather than a
correctness property: the idempotency key already makes a double send harmless.

The costs are real and accepted.

**A second device shows stale reads until it refreshes.** If a meal is logged on the phone, a
desktop tab that is already open keeps showing the day without it until something makes it
re-fetch. There is no push, no subscription and no invalidation. For two people who each log on
their own phone this is close to unobservable; for one person with a phone and a laptop open at
once it is a visible lag of up to one refresh.

**An edit made on two devices while both are offline resolves as last writer wins, by accident
rather than by design.** Both outboxes drain, both writes land, and the later arrival is what
survives. Nothing detects that the two disagreed. This is acceptable only because the window is
small and the data is a personal food diary rather than a shared document.

**A permanently rejected write has to be surfaced rather than retried.** A 422 cannot be fixed
by sending the same bytes again, so the entry leaves the retry loop and waits for a person. That
is a state the UI has to have a place for, which a purely online client would not need.

**The PWA ceiling is accepted.** No Health Connect, no home screen widget, no OS-scheduled
background work. See the native option below.

## Options considered

### A full sync engine with conflict resolution

Bidirectional sync: a change log on both sides, sync tokens, tombstones for deletes, and a rule
for what happens when the same row changed in both places.

Rejected as the largest thing in the project by a wide margin, built for a problem this instance
does not have. It would need a per-row version or an updated-at cursor on every table, a delete
that leaves a tombstone rather than a row that is gone, a resolution rule that has to be right
for meals and weight and classifications separately, and a test suite for concurrent edits that
is harder than everything else here combined. All of it to serve two people who each log on one
phone.

The failure mode is worse than the cost. A sync engine that is subtly wrong loses or duplicates
data silently and is discovered weeks later, in a diary where nobody can reconstruct what was
true. A one-directional outbox that is wrong fails loudly, at the one point where a request is
sent, with an idempotency key underneath it. This is the option the story's own warning names,
and it stays named here so that the next person who thinks "we could just sync both ways" finds
out it was already considered.

### Online-only, with a spinner and a retry button

Write straight to the API, show a failure when it does not work, ask the person to try again.

Rejected because it breaks the product's central claim at exactly the moment it is being made.
The canteen with no signal is not an edge case in a food diary, it is lunch. A retry button also
quietly pushes the duplicate problem onto the user: they tap it twice, or tap it after a request
that actually succeeded before the response was lost, and get two meals. The idempotency key
that prevents that has to exist either way, and once it exists the remaining distance to an
outbox is a queue table and a drain loop.

It is worth being explicit that this option is not simpler in the place that matters. It is
simpler in the client and it moves the complexity into the user's hands.

### A native Android client

Rejected, and this is the option with a genuine cost rather than a straw man.

What was given up:

- **Health Connect.** Weight readings could be read from and written to the platform store, so a
  smart scale that already writes there would populate this app with no entry at all. Over HTTP
  from a browser there is no equivalent, and weight stays typed in by hand.
- **Home screen widgets.** A one-tap "log breakfast" tile on the launcher is the shortest
  possible version of the core interaction. A PWA cannot draw one.
- **WorkManager.** OS-scheduled, guaranteed background execution that survives the app being
  closed and the device rebooting. The outbox drains when the app is open or when Background
  Sync wakes it, which is strictly weaker: an app that is never opened again never drains.

What buys that back:

- One codebase, one language and one deployment for a project with one developer. A native
  client is a second application with its own release process, and the iPad or the laptop still
  needs the web one.
- Installation is a URL. There is no store listing, no review, no signing key to keep for a
  decade, and no account on anybody's developer program for an app two people use.
- The same client serves the desktop, where a good part of the actual usage is, since a PWA
  installs there too.
- Every native capability above has a workable substitute at this scale: weight is typed, the
  launcher icon is one tap further than a widget, and the drain triggers cover every case except
  an app nobody opens, which is a case where nothing needs draining urgently anyway.

This is a decision that could reverse. It is recorded so that reversing it is a decision rather
than a drift.

### Service worker owns the outbox

Put the queue, the request layer and the drain inside the service worker, so Background Sync can
send while no page is open.

Rejected because it duplicates the request layer and the schemas into a second runtime to buy
one trigger. The service worker's job here is the app shell and waking the page, and
`web/public/sw-drain.js` does exactly that and nothing more. Revisit if drains are observed to be
delayed by hours in practice, which would mean people are logging and then not reopening the app.

## What would make us revisit this

**A third device, or two people sharing one account.** The stale-read window stops being
invisible the moment two clients are routinely looking at the same day at the same time.

**A second device becoming normal for one person**, for example logging on a phone and reviewing
on a laptop that stays open. The lag would move from unobservable to annoying.

**Health Connect becoming the way weight actually gets recorded**, for example if a smart scale
enters the picture. That is the native ceiling turning from theoretical into daily friction, and
it is the most likely trigger of the four.

**Drains observed to be delayed for hours**, which would mean the app is being closed after
logging and not reopened, and would justify moving the drain into the service worker.

If multi-device does become real, the shape of the work is known and is deliberately not built
yet: a monotonic **change log** per user so a client can ask what has happened since it last
looked, **tombstones** so a delete is something a client can learn about rather than an absence
it cannot distinguish from a row it never had, and **sync tokens** so a client can resume from
where it stopped instead of re-reading everything. That is the full sync engine rejected above,
and it should be adopted as one deliberate piece of work rather than arrived at one field at a
time.
