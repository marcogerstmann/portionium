---
id: ADR-012
title: 'AI classification as a degradable dependency'
status: Accepted
date: 2026-09-20
---

## Context

Most of what somebody logs is in the seeded catalog: `api/seed/foods.json` is about 240 entries
weighted at German everyday eating, reached through a trigram index with a Damerau fallback, so a
typo and a two character query both still find the name. The model is for the rest, the branded
thing nobody thought of and the dish with a private name.

That makes the model the only part of this application that costs money per use, needs a
credential, talks to a third party, and can be slow, wrong or simply down. It is also the only part
that is genuinely optional: a food with no verdict is not a broken state here, it is the state
`GET /foods/unclassified` exists to drain, and [ADR 011](./011-an-entry-is-a-colour.md) already
settled that a food waits for its own owner rather than being coloured by a machine behind their
back.

The risk worth designing against is therefore the reverse of the usual one. It is not that the
model fails, it is that the rest of the code comes to assume it succeeds: a food creation that
waits on a network call, a read that cannot answer without one, a branch that has never run because
the key has always been set on the machine anybody tested on.

## Decision

One function type, in `api/src/domain/classification/classifier.ts`:

```typescript
type FoodClassifier = (input: ClassificationInput) => Promise<ClassificationResult>;
```

`ClassificationResult` is a union of `classified` and `unavailable`, and `unavailable` carries a
`reason`. `OPENAI_API_KEY` is the whole switch: empty, and the active classifier is
`unavailableClassifier`, which answers `unavailable` and touches no network. Startup logs which of
the two is live, so an instance without a key reads as configured rather than broken.

**No expected failure throws.** A missing key, a timeout, a refusal, an answer that does not parse
and a spent budget are all `unavailable` with a reason. The caller has one shape to handle, and it
is the same shape on a fresh laptop with no key as on a production instance whose provider is
having an afternoon.

**Nothing blocks on it.** Creating a food and logging a meal never wait on the model, and neither
ever fails because of it.

**`OPENAI_MODEL` and `OPENAI_BASE_URL` are configuration with defaults**, which makes pointing at
any OpenAI compatible endpoint, Ollama and llama.cpp included, a value in `.env` rather than a
second implementation with its own tests.

## Consequences

The failure path is the one that runs by default. A developer with no key gets `unavailable` on
every call, which is the branch a production incident would take, so it is exercised continuously
rather than the first time it matters. `api/src/domain` stays pure, since the classifier module
imports `Category` and nothing else, and `.dependency-cruiser.cjs` holds it there. A test
substitutes a classifier by writing a function: no container, no mocking library, nothing to reset.

The costs:

- **A food can sit uncoloured until a person answers for it.** If the provider is down, the key is
  absent, or the answer came back below the caller's confidence filter, that food goes to the
  review queue and stays there until somebody taps a colour. Nothing retries it on a schedule and
  nothing colours it later on its own. We accept that on purpose: the queue is ranked by how often
  the food is eaten, so the ones that matter surface first, and the alternative, a machine quietly
  deciding somebody's diary after the fact, is what ADR 011 exists to prevent.
- **`unavailable` is easy to ignore.** A caller treating it as an empty result rather than an
  absent answer would silently stop classifying anything, and no test would fail. The protection is
  that the field it would have written is nullable and the review queue reads that nullability
  directly, so the symptom is a queue that grows, which is visible.

## Options considered

**A synchronous call on the food creation path.** Create a food, wait for the verdict, return it
coloured. Rejected on three counts: it puts a third party in the latency of the interaction the
product lives on, it makes a provider outage into a write failure, and it makes the composer's
response time a function of somebody else's queue depth.

**A job table and a worker.** Rows in `classification_job`, a poller, states, attempt counts,
backoff, a dead letter state, and a runbook for when the queue stalls. That is a scheduler, and the
thing it schedules already has a human fallback that works. If classification volume ever justifies
durable retries, the job table is the right shape and it deserves its own ADR.

**Throwing on failure, with a typed error.** It would fit `api/src/domain/errors.ts` and
`DOMAIN_PROBLEMS`, which is the established way a domain failure becomes an HTTP answer. Rejected
because it is not a domain failure. Nothing the caller did was wrong and no request should fail:
the model having no opinion is an ordinary outcome, and modelling an ordinary outcome as an
exception means the happy path is written as though it cannot happen and the `catch` is where the
real behaviour hides.

**A provider chain, one classifier falling back to another.** A selection mechanism over two
implementations where one of them is the absence of the other is an `if`. Adding a real second
provider is a decision about spend and data handling, and the day it is taken the chain can be
written with both ends known.

**A rule based classifier under the model.** Keyword lists, a heuristic on the name. Rejected twice
over: it wants `source = 'rules'`, which is a migration and a widened resolution rule in ADR 007
for a guess, and its job is the one the catalog already does better, since deciding whether this
instance knows a name is exactly what the trigram search answers.

## What would make us revisit this

A review queue that people stop draining. The queue is the whole fallback, and it works because it
is short. If uncoloured foods accumulate faster than they are answered, either the model is failing
often enough to need durable retries, which is the job table, or it is succeeding well enough that
its verdicts should apply without confirmation, which is a change to ADR 011 and not to this one.
Either way the number to watch is the depth of `GET /foods/unclassified/count`, not the
classifier's error rate.
