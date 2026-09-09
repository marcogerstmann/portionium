# AGENTS.md

Read this before changing anything. Conventions live here so they are not re-explained per ticket.

## Local setup

Node comes from `.nvmrc`, pnpm from the `packageManager` field via Corepack (`corepack enable`).

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
  seed/             the food catalog that ships with the app, committed
web/                @portionium/web, the PWA, Vite and React
  src/              app code
packages/schemas/   @portionium/schemas, Zod schemas shared by both apps
docs/adr/           architecture decision records
docs/evals/         prompt golden sets and eval results, committed
```

`@portionium/schemas` is consumed over the `workspace:` protocol and its `exports` point at
TypeScript source, not at build output. Vite compiles it for the browser, Node strips the types
for the API, so there is no build step between editing a schema and both sides seeing it.

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

### Versioning

`API_PREFIX` in `app.ts` is where `/api/v1` is written down. A future v2 is a second `register`
call there, not an edit in every route file.

Operational endpoints sit outside it. `GET /health` is unversioned because a version is a promise
about a contract that can change, and there is no v2 of "is this process alive". Its caller is an
orchestrator or an uptime monitor, configured once by someone who is not tracking API versions,
so versioning it means either breaking their probe the day v2 ships or keeping `/api/v1/health`
alive forever as a fossil. Anything a client negotiates over goes under the prefix.

### OpenAPI

The document is generated from the same schemas the routes are validated with and served at
`GET /api/v1/openapi.json`. Swagger UI is at `/api/v1/docs`, behind `API_DOCS_ENABLED`.

There is no hand written spec in this repository, and there will not be one. If the spec and the
code can disagree, the spec is wrong by construction. `api/test/http/app.test.ts` validates the
generated document against the OpenAPI 3.1 specification, so a schema that cannot be expressed as
one fails CI on the commit that introduces it.

### Shutdown

`app.close()` is the whole of it: it stops the listener, drains the requests in flight and then
runs the `onClose` hook that releases the database file. `index.ts` calls it on SIGTERM and
SIGINT, once, so a second signal during a slow drain kills the process rather than starting a
second shutdown.

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
automation. They are revoked one at a time, by their owner.

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
rather than resurrecting it, and it does not move a colour that changed in the file, because the
classification table is append only and choosing between two seed verdicts needs the resolution
rule that does not exist yet.

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
