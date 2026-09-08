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
```

## Layout

Three pnpm workspaces, `api`, `web` and `packages/*`.

```
api/                @portionium/api, Fastify server and MCP adapter
  src/domain/       entities, services, pure logic, no framework imports
  src/db/           Drizzle schema, migrations, repositories
  src/http/         Fastify app, plugins, routes
  src/mcp/          MCP adapter over the domain services
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
database library. `db` may import `domain` and is the only place Drizzle appears. `http` and
`mcp` may import `domain` and `db`, hold no business logic, and never import each other.

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
[`api/src/http/routes/helloworld.ts`](./api/src/http/routes/helloworld.ts) is the worked example
to copy from. It is a placeholder with no product meaning and it is meant to be deleted, along
with this paragraph, once a real v1 endpoint has taken over its job.

Declare a schema for whichever of `params`, `querystring` and `body` the route takes, and for
every status it answers with. A response is serialized through its schema, so a handler that
returns a field the contract does not have fails in the test suite rather than in a client.

Request schemas are strict, both bodies and query strings. A property nobody declared is a
renamed field or a client built against a different version, and answering 200 to it is how that
mistake reaches production dressed as working code. In `@portionium/schemas` that means
`z.strictObject` rather than `z.object`, and a test there holds every `*RequestSchema` to it.

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
