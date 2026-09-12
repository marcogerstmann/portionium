# AGENTS.md

Read this before changing anything. Conventions live here so they are not re-explained per ticket.

## Local setup

Node comes from `.nvmrc`, pnpm from the `packageManager` field via Corepack (`corepack enable`).

`pnpm install` also points `core.hooksPath` at [`.githooks/`](./.githooks), whose `pre-commit`
scans the staged diff for credentials with [gitleaks](https://github.com/gitleaks/gitleaks).
Install it (`brew install gitleaks`) or the hook stands aside with a message; the same scan runs
over the whole history in CI either way. What counts as a secret here, and what to do when one
gets out, is [SECURITY.md](./SECURITY.md).

```sh
pnpm install
cp .env.example .env
pnpm dev                    # api in watch mode
pnpm dev:web                # web on the Vite dev server, http://localhost:5173
pnpm build                  # every workspace, tsc for api and schemas, Vite for web
pnpm test                   # vitest, every workspace
pnpm test:coverage          # the same run with a coverage report, no threshold
pnpm typecheck              # tsc --noEmit, every workspace
pnpm lint                   # eslint + prettier --check
pnpm depcruise              # layering rules
pnpm format                 # prettier --write

pnpm --filter @portionium/api user create --email you@example.com \
  --name "Your Name" --timezone Europe/Berlin   # the first account, see Authentication
```

Or the whole thing in a container, which is what a deployment runs, see Containers:

```sh
docker compose up -d          # http://localhost:8080, migrations and seed included
```

## Layout

Three pnpm workspaces, `api`, `web` and `packages/*`.

```
api/                @portionium/api, Fastify server and MCP adapter
  src/domain/       entities, services, pure logic, no framework imports
  src/db/           Drizzle schema, migrations, repositories
  src/http/         Fastify app, plugins, routes
  src/mcp/          MCP adapter over the domain services
  src/cli/          account administration from a terminal
  test/             integration tests that need a database
  test/helpers/     the test database, the factories and the frozen clock
  drizzle/          generated migration files, committed
  openapi/          the generated spec, committed as the contract snapshot
  seed/             the food catalog that ships with the app, committed
web/                @portionium/web, the PWA, Vite and React
  src/              app code
packages/schemas/   @portionium/schemas, Zod schemas shared by both apps
docs/adr/           architecture decision records
docs/evals/         prompt golden sets and eval results, committed
```

`@portionium/schemas` is consumed over the `workspace:` protocol and its `exports` point at
TypeScript source, not at build output. Vite compiles it for the browser and `tsx` and Vitest
compile it for the API, so there is no build step between editing a schema and both sides
seeing it.

Plain `node` is the exception and cannot load it: type stripping does not remap the explicit
`.js` specifiers NodeNext requires onto the `.ts` files they name, so a compiled `api/dist`
run against this source tree fails on the first relative import. Nothing in development does
that. The container does, and ships the package's `dist/` build instead, see Containers.

Layering inside `api`: `domain` imports nothing from `db`, `http`, `mcp` and no framework or
database library. `db` may import `domain` and is the only place Drizzle appears. `http`, `mcp`
and `cli` may import `domain` and `db`, hold no business logic, and never import each other.

Layering between workspaces: `packages/schemas` imports Zod and nothing else, never anything
from `api` or `web`. `web` may import `@portionium/schemas` and never anything from `api`, the
two talk over HTTP. `api/src/domain` may import `@portionium/schemas`.
[`.dependency-cruiser.cjs`](./.dependency-cruiser.cjs) is the source of truth and CI fails on
violations.

## Rules

- Every user owned table carries `user_id`. Every repository read takes a `userId`. No exceptions.
- IDs are UUIDv7. Timestamps are UTC. Local dates go through the one domain function for it.
- Domain errors are typed. HTTP mapping happens in exactly one place.
- ESM throughout. In `api` and `packages/schemas`, relative imports carry explicit `.js`
  extensions, as NodeNext requires. `web` resolves the way its bundler does
  (`moduleResolution: Bundler`) and omits them. No path aliases in either, a relative path makes
  a layering violation visible in the import itself.
- Unit tests are `*.test.ts` next to the code. Tests that need a database live in `api/test/`.
- Exact dependency versions, the lockfile is committed.

## HTTP

[`api/src/http/app.ts`](./api/src/http/app.ts) builds the Fastify instance. `buildApp()` returns
a server that has not listened yet, so tests get the real application over `app.inject()` rather
than a stub of it. [`api/src/index.ts`](./api/src/index.ts) is the only place that listens, and
the only place that owns a lifecycle.

### Writing a route

A route declares Zod schemas and nothing else. `fastify-type-provider-zod` infers the handler's
argument and return types from them, so the request and response shapes are written down once.
[`api/src/http/routes/auth.ts`](./api/src/http/routes/auth.ts) is the worked example to copy
from. It is registered inside the `API_PREFIX` block in `app.ts`, declares a strict schema for
its body and a schema for every status it answers with, spreads `problemResponses` into that
map, and its handler declares no types of its own.

Declare a schema for whichever of `params`, `querystring` and `body` the route takes, and for
every status it answers with. A response is serialized through its schema, so a handler that
returns a field the contract does not have fails in the test suite rather than in a client.

Request schemas are strict, both bodies and query strings. A property nobody declared is a
renamed field or a client built against a different version, and answering 200 to it is how that
mistake reaches production dressed as working code. In `@portionium/schemas` that means
`z.strictObject` rather than `z.object`, and a test there holds every `*RequestSchema` to it.

### Errors

Every non 2xx response is RFC 9457 Problem Details, served as `application/problem+json`. One
shape, whoever raised the failure, so a client has one parser and one field to branch on.

The wire shape and the list of problem types live in
[`packages/schemas/src/problem.ts`](./packages/schemas/src/problem.ts), because `type` is what a
client branches on and the two sides must narrow the same union. What each failure means over
HTTP lives in [`api/src/http/problem.ts`](./api/src/http/problem.ts), and nowhere else.

Types are minted under `https://portionium.dev/problems/`. They do not resolve to a page yet and
they do not have to, the RFC asks for a stable identifier rather than a live document. A failure
that carries nothing a client would branch on beyond its status code, a 415 from the framework,
gets `about:blank`, which is what the RFC defines it for.

Adding a domain failure is two edits: the code in
[`api/src/domain/errors.ts`](./api/src/domain/errors.ts) and its entry in the `DOMAIN_PROBLEMS`
map. The map is a `Record` over the code union, so doing the first without the second does not
compile. The domain never names a status code.

Routes spread `problemResponses` into their `response` map. That puts the errors into the
generated document next to the happy path, and it serializes the error body through its schema,
so a problem that does not match the contract fails in the test suite.

Two things are deliberate. An unexpected exception answers 500 with a fixed sentence and nothing
else, while the stack goes to the log, because a message that helps a developer is a message that
describes internals to whoever asked for it. And every problem carries `requestId`, the id the
failure was logged under, which is what turns "it broke yesterday" into one log lookup. Fastify
generates that id and does not read it from a request header, so a client cannot choose what it
is called in the logs.

### Idempotent writes

Every authenticated `POST`, `PUT`, `PATCH` and `DELETE` accepts an `Idempotency-Key` header. The
first request carrying a key runs and its response is stored, status, body and content type,
under the key and the caller's user id. A retry with the same key and the same fingerprint, a
SHA-256 of method, URL and canonicalised body, gets the stored response back with
`Idempotent-Replayed: true` and runs nothing. Why, and what was rejected, is
[ADR 004](./docs/adr/004-idempotency-keys.md).

The row is claimed before the handler runs and filled in after it, in
[`api/src/http/plugins/idempotency.ts`](./api/src/http/plugins/idempotency.ts). A unique index
over `(user_id, key)` is the whole of the concurrency story: two copies of one request both try
the insert, one gets through, and the other finds a row with no response yet and is answered
409 to retry shortly. The same key with a different fingerprint is 422 and runs nothing. A 500
releases the claim, so the retry runs the request again. A request without the header runs every
time it is sent, and a public route, which today is the login, ignores the header because there
is no user to file a key under.

Rows are purged hourly once older than `IDEMPOTENCY_RETENTION_HOURS`, 24 by default. Routes that
change something spread `idempotencyProblemResponses` into their `response` map so the two
statuses appear in the generated document.

### Rate limiting, headers and CORS

Three hooks on the root instance, registered in `buildApp` before the auth plugin, so no route
opts in and no route can opt out.

**Rate limiting.** Counted per minute in three buckets, because the three cost the server
different things: a read is a query against a file already in the page cache, a write is a
transaction and an fsync, and a sign in is an Argon2id verification at 19 MiB. Anything under
`/api/v1/auth` is charged to the auth bucket whatever its method, everything else by method,
safe or not. Defaults are 120, 30 and 20, all three configurable.

Every request is counted against two keys, the SHA-256 of whatever credential it presented and
the caller's address, and both have to be under the limit. Neither would do alone. Without the
address key, sending a different forged token on every request buys an unlimited number of
buckets. Without the credential key, one stolen token spread over a hundred addresses leaves a
hundred untouched counters. For one person on one address the address counter is the binding
one, which is expected.

The hook runs **before** authentication, and that ordering is the point rather than an accident
of the file order. Fastify stops the hook chain at the first failure, so a limiter behind the
auth plugin would never count a request carrying a dead credential, which is what a flood is
made of. It also means the cheapest check happens before the database is touched and before
Argon2 runs.

`GET /health` is never limited. An orchestrator reads a 429 as a dead process, and behind a
proxy that does not forward the client address every caller shares one IP, which is exactly the
case where the probe would be starved and the container restarted.

A refusal is 429 with `Retry-After` and `PROBLEM.rateLimited`, distinct from the login lockout's
`PROBLEM.tooManyLoginAttempts` so a client can tell "slow down" from "this address is being
locked out". Both are `ThrottledError`, and `http/problem.ts` sets the header off the base class
so a third throttle cannot ship a 429 that forgot it.

Counters are a `Map` in this process, one integer and one timestamp per key, sharing
[`domain/window-counter.ts`](./api/src/domain/window-counter.ts) with the login lockout. They
reset when the process does. Why that is acceptable, why not Redis, and what would change our
minds is [ADR 005](./docs/adr/005-no-redis-no-metrics-stack.md).

**Security headers**, in [`api/src/http/plugins/security.ts`](./api/src/http/plugins/security.ts)
and nowhere else: `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and a
`Content-Security-Policy` that permits nothing, since this API answers JSON. The Swagger UI is
a real page and gets its own looser policy rather than an exemption. `Strict-Transport-Security`
follows `WEB_ORIGIN`'s scheme, the same derivation as the session cookie's `Secure` flag, so a
developer on plain http does not pin localhost to https for an afternoon.

**Body size** is `MAX_BODY_BYTES`, a megabyte by default, passed to Fastify's own `bodyLimit`.
It refuses before the body is read into memory, which is what makes it a limit rather than a
check, and the 413 becomes a problem document like anything else.

**CORS is off** unless `CORS_ORIGINS` lists exact origins. There is no wildcard and no pattern:
every response here is credentialed, so `*` is refused by the specification anyway. When the
list is non empty, `Vary: Origin` goes on every response including the ones that get no allow
header, or a shared cache hands the allowed answer to somebody else. A preflight is answered in
the hook rather than by a route, before authentication, because a browser sends it without
credentials by definition and a 401 to it reads as "blocked by CORS" in every console.

### Versioning

`API_PREFIX` in `app.ts` is where `/api/v1` is written down. A future v2 is a second `register`
call there, not an edit in every route file.

Operational endpoints sit outside it. `GET /health` and `GET /ready` are unversioned because a
version is a promise about a contract that can change, and there is no v2 of "is this process
alive". Their caller is an orchestrator or an uptime monitor, configured once by someone who is
not tracking API versions, so versioning them means either breaking their probe the day v2 ships
or keeping `/api/v1/health` alive forever as a fossil. Anything a client negotiates over goes
under the prefix.

### Pagination

Written down once, in
[`packages/schemas/src/api.ts`](./packages/schemas/src/api.ts), before the first list endpoint
exists, so the second one cannot invent a second convention. Two query parameters, `limit` and
`cursor`, and one envelope, `{ items, nextCursor }`.

Cursor based rather than offset based. An offset addresses rows by position, so a row written
or removed while somebody is paging shifts everything after it and the client sees an entry
twice or misses one. Meals and weight entries come back newest first and are written
continuously, which is exactly the case an offset gets wrong.

A cursor is opaque and the only correct thing a client can do with one is send it back. What it
contains is the endpoint's business, and since every id here is a UUIDv7 and therefore already
sorts by creation time, in practice it is the last id of the page. There is deliberately no
encode or decode helper yet: nothing issues a cursor, and a helper written now is a guess the
first real endpoint would have to work around. `nextCursor` is null on the last page rather
than absent, so a client has one check for "there is more" instead of two.

### OpenAPI

The document is generated from the same schemas the routes are validated with and served at
`GET /api/v1/openapi.json`. Swagger UI is at `/api/v1/docs`, behind `API_DOCS_ENABLED`.

There is no hand written spec in this repository, and there will not be one. If the spec and the
code can disagree, the spec is wrong by construction. `api/test/http/app.test.ts` validates the
generated document against the OpenAPI 3.1 specification, so a schema that cannot be expressed as
one fails CI on the commit that introduces it.

The generated document is also committed, at
[`api/openapi/openapi.json`](./api/openapi/openapi.json), and
`api/test/http/openapi-snapshot.test.ts` compares the two. A change to the public contract is
therefore a diff in the pull request that causes it: a reviewer sees that a field was renamed
or a status added without reading the route, and a change nobody meant to make has to be staged
deliberately before it can be merged. Regenerate with:

```sh
pnpm --filter @portionium/api openapi
```

That script is `vitest -u` over the same test. There is no separate generator and no extra CI
step on purpose, because a snapshot written by something other than what verifies it is a
snapshot that can be right about a document nobody serves.

There is no generated client, and there will not be one. The web app imports its request and
response types from `@portionium/schemas`, which is the same definition the server validates and
serializes with, so the two cannot drift and a contract change breaks the typecheck on both
sides in one commit. A generated client would be a third copy of shapes that already exist
twice, regenerated on a schedule somebody forgets. The spec is here for documentation, for the
snapshot above, and for a consumer that is not this repository.

### Serving the web client

When `WEB_ROOT` names a directory, this process serves the built client from it on the origin it
already answers on. Empty by default, so development and every test serve the API alone: there
the client runs on the Vite dev server and proxies `/api` here.

One origin rather than a second server in front is the point. The session cookie is
`SameSite=Lax` and every write is checked against `WEB_ORIGIN`, so a client served from anywhere
else is a client whose writes are refused until CORS and a second origin are configured. Serving
both halves from one process makes that configuration unnecessary rather than merely easy, and
is what lets the application ship as one container.

It is served from the **not found handler**, in
[`api/src/http/plugins/static.ts`](./api/src/http/plugins/static.ts), and that is the whole
design rather than a detail. `@fastify/static` left to itself registers a wildcard `GET`, and a
wildcard at the root claims every URL no route matched, `/api/v1/mistyped` included, which would
then be answered with the app shell and a 200 where this API owes a problem document. It also
cannot declare `config.auth`, which every route here must. So it is registered with
`serve: false`, which decorates `reply.sendFile` and registers nothing, and the handler runs only
once the router has confirmed nobody else wanted the URL. The public surface in
`test/http/authorization.test.ts` and the generated OpenAPI document are both unchanged by it.

Four answers, in order: a path under `/api/v1` is declined and stays a problem document; a path
naming a file that exists is that file; a path that looks like a file and is not one is a 404,
because answering a missing bundle with HTML is a syntax error in somebody's console instead of a
plain message; anything else is the app shell, which is what makes a client route survive a
reload.

The list of files is read once at startup. The directory is baked into the image and cannot
change while the process runs, so this is a lookup rather than a `stat` per request, and it is
also the safety property: a path not literally in that set is never handed to the sender.

Cache headers are two answers and no more. Anything under `assets/` is `immutable` for a year,
which is safe only because Vite puts a hash of the contents in those names, so a changed file is
a different URL. Everything else, the shell and the service worker included, is `no-cache`,
meaning revalidate rather than do not store. Those two decide which version of the app somebody
is running: a cached `index.html` points at bundles that may be gone, and a cached service worker
is an old app that never learns there is a new one.

The Content Security Policy gains a third case in
[`security.ts`](./api/src/http/plugins/security.ts). The API's own `default-src 'none'` would stop
the client loading its own bundle, so a request the router did not match gets a policy a page can
run under: `'self'` for scripts, and inline styles allowed because a policy that breaks the app is
a policy somebody switches off entirely. Script stays strict, which is the half the `HttpOnly`
cookie depends on.

### Shutdown

`app.close()` is the whole of it: it stops the listener, drains the requests in flight and then
runs the `onClose` hook that releases the database file. `index.ts` calls it on SIGTERM and
SIGINT, once, so a second signal during a slow drain kills the process rather than starting a
second shutdown.

### Logging and the two probes

Pino, which is Fastify's own logger, writing one JSON object per line to stdout at `LOG_LEVEL`.
Every request gets an id and a child logger bound to it, so the two lines a request writes and
every application line in between carry the same `reqId`, and that id is in the body of every
error response, which is what turns "it broke yesterday afternoon" into one log lookup. Fastify
logs the status and the duration on the completion line;
[`api/src/http/logging.ts`](./api/src/http/logging.ts) adds the method and the path to it, so the
line somebody greps for says what it was a response to.

What a line may never carry is in that same file, as Pino redaction paths, rather than at the
call sites: passwords, tokens, addresses in full and the content of any prompt sent to a model,
each matched both bare and one level in. A rule applied where the line is written is a rule every
line already follows, including the ones nobody has written yet. An address is masked rather than
dropped, because a burst of failures against one domain is the shape worth noticing, and
`maskEmail` on an already masked address returns it unchanged, so a call site that masks
deliberately is not punished for it.

Startup logs the resolved configuration, with any value whose key names a secret replaced. The
list of such keys is empty today and the match is on the name, so the day an API key for the
classifier arrives it is masked without anybody remembering, see `maskedConfig`.

An uncaught exception or an unhandled rejection is logged at fatal and ends the process, in
[`api/src/index.ts`](./api/src/index.ts). Nothing is drained first: a graceful shutdown in a
state nothing can reason about is how a container hangs instead of restarting.

Two probes, because an orchestrator does two different things with the answers. `GET /health` is
liveness and deliberately does not touch the database, since a check that fails on a held write
lock would have the process killed for a condition that clears itself in milliseconds.
`GET /ready` is readiness and does: one statement that answers both whether the file still
responds and whether its schema is the one this build ships, see `databaseNotReadyReason` in
[`api/src/db/client.ts`](./api/src/db/client.ts). That second half looks tautological, since
migrations run before the listener opens, and it catches the case that is not normal, this
process talking to a different file than the one it migrated.

Neither probe needs a credential and neither carries a version, a commit, an uptime or any
configuration. An unauthenticated caller gets a status code; why an instance is not ready names
a schema version and goes to the log instead. Neither is rate limited either, because a 429 reads
as a dead process to one caller and as an instance to stop sending traffic to for the other.

Why there is no Prometheus, no OpenTelemetry and no dashboard, and the concrete trigger that
would change that, is [ADR 005](./docs/adr/005-no-redis-no-metrics-stack.md).

## Authentication

Accounts are made by an administrator. There is no public registration endpoint in this
repository and self service sign up is out of scope: an instance serving two people has nothing
to gain from it and a great deal to lose.

### Passwords

Argon2id, at OWASP's current parameters: 19 MiB of memory, two passes, one lane. They are
written out in `ARGON2_OPTIONS` in [`api/src/domain/auth.ts`](./api/src/domain/auth.ts) rather
than left to the library's defaults, because a security parameter that lives in somebody else's
package can change in a patch release without anybody deciding to.

Each hash is a PHC string carrying the cost it was made with, so raising these later needs no
migration and no downtime. It does need a rehash on the next successful login to be worth
anything, which is a few lines that should not be written until the numbers move.

### What the login endpoint refuses to say

`POST /api/v1/auth/login` answers a wrong password and an address with no account with the same
status, the same problem type and the same sentence. Two things keep that true, and both are
easy to undo by accident:

- The handler always runs a real Argon2 verification, against the account's hash or against
  `DUMMY_PASSWORD_HASH` when there is no account. Returning early for an unknown address answers
  in microseconds where a wrong password costs tens of milliseconds, and that gap is measurable
  from the other side of the internet. The dummy's parameters have to match the ones above, which
  is asserted rather than trusted.
- Failed attempts are counted against an address whether or not it exists. A lockout that only
  ever happened to real accounts would answer the same question, more slowly.

Failures are logged with the local part of the address masked, the IP, and whether the account
existed. That distinction is in the log, where the person reading it is entitled to it, and
never in the response.

### Lockout policy

Counted in a fixed window, in process memory, in
[`api/src/domain/auth.ts`](./api/src/domain/auth.ts).

| Key   | Failures | Window     | Effect                           |
| ----- | -------- | ---------- | -------------------------------- |
| Email | 5        | 15 minutes | 429 for that address from any IP |
| IP    | 20       | 15 minutes | 429 for any address from that IP |

The window starts at the first failure and does not move, so a steady drip cannot hold a key
locked forever. A successful login clears the address, never the IP, otherwise one attacker with
one working password resets their own spray. A locked out request is refused before any hashing,
so the lockout limits the server's work rather than inviting more of it. Every 429 carries
`Retry-After`.

The counters live in memory and reset when the process does. That is the same tradeoff recorded
for the rate limiting story, and it is the reason both belong in one SQLite table on the day
either of them stops being enough.

### Sessions

A login writes a `session` row and sets `portionium_session`, an `HttpOnly` cookie carrying an
opaque token and nothing else. The token is never in the response body: a body is something the
page can read, and a credential the page can read is a credential anything injected into that
page can read too.

The row stores a SHA-256 of the token and never the token itself, so a copy of the database file
is not a set of live sessions. SHA-256 rather than Argon2id because the token is 256 bits from a
CSPRNG: there is nothing to brute force, and it has to be cheap enough to check on every request.
It is not a UUIDv7 like every other id here, because those sort by creation time, which is what
an identifier should do and what a credential must not.

Cookie attributes are written down in one place, `sessionCookie` in
[`api/src/http/plugins/auth.ts`](./api/src/http/plugins/auth.ts): `HttpOnly`, `SameSite=Lax`,
`Path=/`, a relative `Max-Age` so a wrong client clock cannot extend it, and `Secure` whenever
`WEB_ORIGIN` is https. That last one follows the origin rather than `NODE_ENV`, because a
developer on plain http needs a cookie their browser will actually store and a second variable
is a second thing to set to the wrong half of the pair.

Expiry slides. `SESSION_TTL_DAYS`, thirty by default, is an idle timeout rather than a lifetime:
a request on a live session pushes `expires_at` out again and stamps `last_activity_at`. Both
writes are throttled to one a minute per session by `ACTIVITY_INTERVAL_MS`, because otherwise
every read this API serves is also a write to the row that authorised it. `GET /auth/sessions`
lists a user's live sessions with those two timestamps and marks the one the request came in on;
`DELETE /auth/sessions/:id` and `POST /auth/logout` delete the row, so the credential is dead
whatever the client does with the cleared cookie.

### CSRF

A browser attaches cookies to a cross site request as willingly as to a first party one, which
is the whole of CSRF. So a mutating request authenticated by the cookie has to carry an `Origin`
header equal to `WEB_ORIGIN`. A missing header is refused rather than trusted: every browser
sets it on a cross origin request, so its absence on a mutation is either a client nobody
supports or somebody hoping the check is a whitelist.

The check runs in the same `onRequest` hook that establishes identity, before the database is
touched, and only for a credential that came from the cookie. Safe methods are exempt because
forging one achieves nothing, and bearer requests are exempt because nothing attaches a bearer
header on a page's behalf.

### API tokens

The other credential, for the MCP server and anything else without a browser.
`POST /auth/tokens` mints one, `GET /auth/tokens` lists them without the tokens, and
`DELETE /auth/tokens/:id` revokes one. Rows live in `api_token` and store a SHA-256, a name, the
granted scopes, `last_used_at`, `expires_at` and `revoked_at`.

Five things are deliberate:

- **The plaintext exists in one response, once.** Only the digest is stored, so nobody can
  produce that string again, including whoever holds the database file.
- **Tokens wear `prt_`.** Secret scanners match on shapes like that, and a credential nobody can
  recognise on sight is one somebody else finds first. The prefix is also how the request path
  knows which table to read, so a request costs one lookup rather than two.
- **A token cannot mint a token.** `POST /auth/tokens` refuses a bearer credential with
  `SessionRequiredError`, so a stolen token cannot be turned into a successor that outlives its
  revocation. This is why tokens are created from the web client and there is no pairing flow.
- **A token can never carry more than its owner.** Requested scopes are checked against the
  user's role at creation, and again intersected with it on every request, so demoting an
  account narrows the tokens it already issued.
- **`last_used_at` is throttled**, one write a minute per token, same as a session's activity.

Revoking sets `revoked_at` and the next request carrying that token fails, because there is no
cache in front of the lookup. A revoked row is kept rather than deleted: its name and last use
are the record of what the credential was doing, which is the first thing anybody wants after
turning one off. Changing a password ends every session and deliberately leaves tokens alone,
see `setPasswordHash`.

### Authorization

Who a request is from is established in one place,
[`api/src/http/plugins/auth.ts`](./api/src/http/plugins/auth.ts), which resolves a bearer token or
a `portionium_session` cookie into `request.auth`. Why the design looks like this is
[ADR 003](./docs/adr/003-multi-user-authorization.md).

Four rules, and each is enforced rather than remembered:

- **Every route declares who may call it.** `config: { auth: 'read' }`, `'write'`, `'admin'`, or
  the word `'public'`. A route that declares nothing throws at registration, so the server does
  not start. Scopes come from `SCOPES` in `packages/schemas`, because a user names them when
  minting a token and they are therefore on the wire. Stronger implies weaker, see
  `expandScopes`. A session carries everything its owner's role gives; a token carries what its
  owner chose, intersected with that.
- **The public surface is a list in a test.** `api/test/http/authorization.test.ts` holds the
  three endpoints reachable without a credential and compares them against the routes actually
  registered, so making a fourth one public is a visible line in a diff.
- **`request.auth` is the only source of a user id.** It is a getter over a frozen object, so a
  handler can neither replace it nor edit it, and reading it on a public route throws. Never take
  a user id from a body, a query string or a path segment. Request schemas are strict, so one that
  arrives is a 400, and a test greps the adapters for a handler that reads one anyway.
- **A row belonging to somebody else is a 404, never a 403.** Repositories filter by `userId`, so
  a foreign row does not come back and the handler raises `ResourceNotFoundError` without knowing
  the difference. 403 is for `InsufficientScopeError` alone, which says something about the caller
  rather than about which ids exist.

### Administration

There is no HTTP endpoint for making accounts. The first one cannot have one, because it would
have to be reachable without credentials, and on a public instance that is not a bootstrap but a
vulnerability. Being on the machine with the database file is the authorisation, which is the
same authorisation restoring a backup needs.

```sh
pnpm --filter @portionium/api user create --email a@b.de --name "Ada" --timezone Europe/Berlin
pnpm --filter @portionium/api user passwd --email a@b.de
pnpm --filter @portionium/api user revoke-tokens --email a@b.de
```

The first account on a fresh instance is an admin unless `--role` says otherwise, because there
is nobody to have granted it. The password is never an argument: anything on a command line is in
a shell history and in the process list of everybody on the machine, so it is typed at a prompt
that does not echo or piped in by a script that has it already.

Creating a user and resetting a password over HTTP would need a route declaring `admin`, which
the plugin already enforces. The functions such a route would call are already in
[`api/src/db/auth.ts`](./api/src/db/auth.ts). Nothing in the API requires `admin` yet.

Changing a password ends every session opened with the old one, in the same transaction. API
tokens are deliberately left alone: they are a credential a user issued on purpose to a script
that is not sitting at the keyboard, and revoking them as a side effect of good hygiene breaks
automation. They are revoked one at a time, by their owner, or all at once with `revoke-tokens`
above, which is the incident command and not the everyday one. Which credential to rotate when,
and in what order, is [SECURITY.md](./SECURITY.md).

### The account over HTTP

Three endpoints, in [`api/src/http/routes/me.ts`](./api/src/http/routes/me.ts), and no id in any
of their paths. The caller is `request.auth` and nothing else, so `/me` is the only spelling of
"my profile" and there is no version of it that can be pointed at another account by editing a
URL. Reaching somebody else's row here is not refused, it is not expressible.

`GET /api/v1/me` answers the profile. `PATCH /api/v1/me` changes the display name, the timezone
and the day boundary hour, and nothing else: the request schema is derived from `userSchema` and
has no field for an email or a role, so a caller that sends one gets a 400 rather than having it
ignored. The timezone is held to `timezoneSchema`, which asks the runtime's own IANA database, so
`CEST` is refused before anything tries to derive a local date from it. A field the body does not
name is a field nobody touched, which is what stops one stale tab writing back over an edit made
in another.

`POST /api/v1/me/password` changes the password, and three things about it are deliberate:

- **The current password is required and verified.** The session on the request proves the
  browser was signed in at some point, not that the person at the keyboard is the owner, which is
  exactly what an unattended session is.
- **A wrong current password is 403 `invalid-current-password`, not the login's 401.** A 401 on
  an authenticated request is read by every sensible client as "your session is over", and
  signing a user out because they mistyped one form field is the wrong reaction to a typo.
- **An API token cannot call it.** It answers `SessionRequiredError`, the same rule that stops a
  token minting a token. A token is issued to a script, and a script that can change the password
  can lock its owner out of the account it was given limited access to.

It ends every session, this one included, and clears the cookie on the way out, so signing in
again is the next step. API tokens survive, see `setPasswordHash`.

## Database

One SQLite file is the whole persistence layer, opened in exactly one place,
[`api/src/db/client.ts`](./api/src/db/client.ts). Why SQLite and not PostgreSQL, and what would
make us change our minds, is [ADR 001](./docs/adr/001-sqlite-over-postgresql.md).

Every table spreads `baseColumns` from [`api/src/db/schema/base.ts`](./api/src/db/schema/base.ts),
which supplies `id` (UUIDv7), `created_at`, `updated_at` and `deleted_at`. Schema files live in
`api/src/db/schema/`, one per table.

### Changing the schema

```sh
pnpm --filter @portionium/api db:generate add_meal_table
```

Edit the schema file, then generate. The name is not optional and it is not decoration: the
script ends in `--name`, so the argument is appended to it and drizzle-kit exits with an error if
you leave it out. Without it you get `0007_flowery_micromacro.sql` and nobody reviewing the diff
in a year can tell what it did. Use `snake_case`, describe the change, not the ticket.

Generated SQL goes to `api/drizzle/`, is committed, and is applied by `openDatabase()` at startup
rather than by a separate deploy step. Drizzle records what it has applied, so booting twice
applies nothing twice.

A migration that has been applied anywhere is frozen. Never edit it, never renumber it, never
delete it. Fix it forward with a new migration.

### Rolling back

There are no down migrations. Drizzle does not generate them and hand written ones rot, because
the reverse of a destructive change is not derivable from the change itself. The recovery path is
to **restore the database file from backup and redeploy the previous release**. SQLite makes that
cheap: stop the process, copy `portionium.db` back into place along with its `-wal` and `-shm`
sidecars, start the old version.

This is why a migration that drops or rewrites data is worth a second pair of eyes, and why
`strict` is on in `drizzle.config.ts`, so drizzle-kit asks before generating one.

### Seed catalog

[`api/seed/foods.json`](./api/seed/foods.json) is the food catalog that ships with the app,
roughly 240 entries weighted towards German everyday eating. It is product data, not test data: a
good catalog means the AI classifier is rarely reached, which is the behaviour the project claims.

Colour is energy density as the food is eaten, not as it is sold. Green under roughly 120 kcal per
100 g, yellow up to roughly 250, orange above that. Drinks are judged by what a normal glass
delivers rather than per 100 ml, because a cola is 42 kcal per 100 ml and still a glass of sugar.
Nuts and oils come out orange despite being good food, which is the honest answer an energy density
model gives. The rule is repeated at the top of the JSON file, because that is where it gets
ignored.

`seedFoodCatalog()` in [`api/src/db/seed.ts`](./api/src/db/seed.ts) runs at startup, right after
the migrations and for the same reason. It compares the file against the database on every run
rather than recording that it has run, so adding entries and restarting is the whole deployment
step, and a run interrupted halfway heals itself on the next boot.

Seeded rows belong to nobody. `food.created_by` is null and so is `food_classification.user_id`,
which is what makes one catalog serve every account while a user's own opinion stays a separate
row. Two things the loader deliberately does not do: it leaves a soft deleted seed food deleted
rather than resurrecting it, and it does not move a colour that changed in the file. The
resolution rule would take the newer of two seed verdicts, so a corrected colour would arrive on
a restart without anybody deciding it should, and correcting a shipped verdict is a deliberate
act. The loader writes through `insertClassifications` like everything else, see below.

### Classifications

A food has no colour. It has a stack of opinions about its colour, and
[`api/src/db/classification.ts`](./api/src/db/classification.ts) is the log of them: one row per
verdict, carrying the source (`seed`, `ai_text`, `ai_vision`, `user`), the user it belongs to or
null when it belongs to everybody, and the model's provenance when a model produced it.

Nothing updates a row and nothing deletes one. A verdict is corrected by inserting a newer one,
which is what keeps the disagreement, and the disagreement is the data: it is what later answers
how often the classifier was wrong and at what confidence. The enforcement is that the module
exposes one write and it inserts, so there is no function that could break the rule. Why, and
what it costs on every read, is [ADR 007](./docs/adr/007-append-only-classification-log.md).

Which verdict wins is `resolveClassification` in
[`api/src/domain/classification.ts`](./api/src/domain/classification.ts), and that is the only
place the order is written down: the caller's own most recent verdict, then the most recent model
verdict, then the one that shipped, then no colour, which is a state rather than a failure. Every
read path goes through it, so a list and a detail view cannot disagree about what somebody is
looking at. `resolveClassifications` does the same for a whole page from one query, which is why
fifty foods are two statements and not fifty one.

`GET /api/v1/foods/{id}/classification/history` is the log itself, unresolved and newest first.
It carries the shared rows and the caller's own, never another account's.

### Search

`GET /api/v1/foods/search?q=` is the endpoint the core interaction sits on, so the two halves of
it are deliberately in different places.

Recall is SQLite's FTS5, in a `food_search` virtual table tokenised into trigrams. That is what
makes a query match inside a word and across a space, so `kyr` finds `Skyr` and `nut but` finds
`Peanut Butter`. The table is kept in step with `food` by triggers, added in
[`0005_add_food_search_index.sql`](./api/drizzle/0005_add_food_search_index.sql), so nothing in
TypeScript writes to the index and nothing can forget to. That migration also backfills the
entries already in the catalog, which is the half that fails invisibly, and
`api/test/food-search.test.ts` runs the migrations in two halves to prove it does not.

Ranking is [`api/src/domain/food-search.ts`](./api/src/domain/food-search.ts), in memory, over
the rows that came back. Exact match, then the caller's own most recently eaten foods, then how
often the instance eats it, then lexical relevance. The second key is the one that matters: most
of anyone's diet is the same twenty foods, so a personal history predicts what somebody is
typing better than anything about the catalog does.

Two things the index cannot do, and both fall through to a scan of the live names in
JavaScript, which runs only when the index came back with less than a full page. A query shorter
than three characters, because a trigram index has nothing to match it against, which is
answered with a prefix. And a typo, because `Sykr` shares no trigram at all with `Skyr`, which
is answered with a Damerau edit distance of one. Case folding happens there rather than in SQL
for the reason `normalizeFoodName` gives.

An empty `q` is not an error. It answers with the caller's most eaten foods, degrading to what
the instance eats and then to the catalog by name, because a search box is focused before it is
typed into and an autocomplete that opens empty is one nobody uses.

`api/test/food-search.test.ts` holds the benchmark: 5000 entries, a median under 50 ms per
query. It is there to catch a change of kind, a scan added to the hot path or an index that
stopped being used, rather than to police a millisecond.

### Tests

`createTestDatabase()` in [`api/test/helpers/database.ts`](./api/test/helpers/database.ts) gives a
fresh migrated database in its own temp directory. `close()` drops the connection and the
directory. It uses a file rather than `:memory:`, because WAL and the busy timeout only mean
anything for a real file. Integration tests run against that file, never against a mock or an
in-memory fake.

`createTestFixtures()` in [`api/test/helpers/fixtures.ts`](./api/test/helpers/fixtures.ts) is that
database with two accounts already in it, `userA` and `userB`, plus `create`, the row factories.
Two accounts because almost every read takes a `userId`, and a test with one user cannot tell a
query that filters by owner from one that forgot to. They sit in different timezones on purpose,
so a service reaching for the wrong user's day context produces a visibly wrong local date rather
than the right answer by luck.

The factories are synchronous, take overrides on top of sensible defaults, and build rows the way
the application builds them: `create.meal()` goes through `createMeal`, so positions and the local
date are derived rather than invented. A factory that made those up itself would let a suite pass
against rows the application could never produce.

`freezeTime()` in [`api/test/helpers/time.ts`](./api/test/helpers/time.ts) pins the clock for the
rest of the test and restores it on its own. Day boundaries, streaks and trends answer differently
depending on what now is, so assertions about them are only worth something against a stopped
clock. Only `Date` is faked, not timers, which would break the driver's busy timeout for no gain.

### Coverage

`pnpm test:coverage`, v8 provider, text and HTML and lcov into `coverage/`. The target is
**80 percent of `api/src/domain` and `api/src/db`**, and the adapters follow once they exist.

There is no threshold and CI does not fail on the number, on purpose. A gate turns the report into
something to satisfy, and the tests written to satisfy a gate are the ones that assert nothing. The
report is there to be read: the useful line is a module showing up as a row of zeroes, not the
percentage at the bottom. Schema files and the process entry point are excluded, there is nothing
in them to cover.

## Containers

One image holds the compiled API, its production dependencies and `web/dist`, and the API serves
all three. [`Dockerfile`](./Dockerfile) is three stages: `deps` resolves the production tree from
the manifests alone so editing a source file does not reinstall `better-sqlite3`, `build` has the
compiler and the dev dependencies and keeps neither, and `runtime` is assembled from the two with
no package manager in it. It runs as `node`, uid 1000.

Migrations and the food catalog are applied by `openDatabase()` and `seedFoodCatalog()` at
startup, before the listener opens, so starting the container is the whole deployment step. The
database is at `/data`, which is a volume in both the Dockerfile and the Compose file: the
`VOLUME` is there for the `docker run` case, where without it the only copy of somebody's data
goes into a writable layer that disappears with the container.

The image declares its own `HEALTHCHECK` rather than the Compose file, so a plain `docker run`
gets it too and there is one definition of healthy. It is written in Node against `/health`
because the base image has no curl, and `/health` is liveness only and never rate limited.

One thing in the image is spelled differently from a checkout. `@portionium/schemas` points its
`exports` at `src/index.ts`, which is what keeps both apps reading one definition with no build
step in between, and which **Node cannot load**: type stripping does not remap the explicit `.js`
specifiers NodeNext requires onto the `.ts` files they name, so `node api/dist/index.js` against
the source tree fails on the first relative import. `tsc` already emits the package to `dist/`,
so the runtime stage ships a manifest naming that instead. Nothing but starting the container
would notice if the two ever disagreed, which is why CI starts it.

[`docker-compose.yml`](./docker-compose.yml) needs no editing for a first run: settings go in an
optional `.env.docker` mirroring `.env.example`, and the two knobs that belong to Compose rather
than the app, `PORTIONIUM_PORT` and `PORTIONIUM_BIND`, are read from the environment. A `caddy`
profile adds a reverse proxy with automatic TLS for a deployment on a domain, which is not
optional for a PWA: a browser will not register a service worker on an insecure origin.

The image unpacks to about 209 MiB and is about 75 MiB to pull. Node's own binary is 121 MiB of
that and the production dependency tree is 63, so the CI limit is 215 MiB rather than the 200 the
story asked for: stripping type declarations, source maps and documentation out of `node_modules`
is worth roughly 8 MiB and there is nothing after it. The limit sits just above where the image
is, so it catches a regression instead of describing something unreachable. It is measured by
reading the unpacked filesystem, because `docker image inspect .Size` reports the uncompressed
size on the classic image store and the compressed size on the containerd one.

The `image` job in CI builds for this machine on every push, asserts the size, starts the
container, waits for its own healthcheck and then checks what it serves. That job is the only
thing that proves any of the above, so a change here is not done until it is green. On a `v*`
tag it also builds amd64 and arm64 and pushes to GHCR, because a home deployment may be a
Raspberry Pi or a Mac.

## Writing changes

- Work lands directly on `main`. There is one developer, so a pull request would be a review with
  nobody to review it, and CI runs on every push to `main` regardless. Conventional commit
  messages, tests accompany every behaviour change. Revisit when a second person joins, which is
  the point at which a branch and a review stop being ceremony and start catching something.
- Do not reference Jira keys in code comments or identifiers. Keys change, code should read on its
  own. Commit messages may name the story in words.
- ADRs live in [`docs/adr/`](./docs/adr/). A story with an ADR criterion is not done until the ADR
  exists.
- No em dashes in documentation or generated text. Use commas or sentence breaks.

## Toolchain note

TypeScript is pinned to 6.x. TypeScript 7 is the native compiler and its API is not published yet,
so `typescript-eslint` and `dependency-cruiser` cannot read it. Bump both together once they
support 7, and confirm `pnpm depcruise` still reports a non zero module count.
