# AGENTS.md

The conventions this repository is held to. Decisions that were expensive to make live in
[`docs/adr/`](./docs/adr/) and are not repeated here; this file says what to do, and points at the
ADR when you need to know why.

## Local setup

Node comes from `.nvmrc`, pnpm from the `packageManager` field via Corepack (`corepack enable`).

`pnpm install` points `core.hooksPath` at [`.githooks/`](./.githooks), whose `pre-commit` scans the
staged diff with [gitleaks](https://github.com/gitleaks/gitleaks). Install it (`brew install
gitleaks`) or the hook stands aside with a message. The same scan runs over the whole history in CI
either way. What counts as a secret, and what to do when one gets out, is
[SECURITY.md](./SECURITY.md).

```sh
pnpm install
cp .env.example .env
pnpm dev                    # api in watch mode
pnpm dev:web                # web on the Vite dev server, http://localhost:5173
pnpm build                  # every workspace
pnpm test                   # vitest, every workspace
pnpm test:coverage          # the same run with a coverage report, no threshold
pnpm typecheck              # tsc --noEmit, every workspace
pnpm lint                   # eslint + prettier --check
pnpm depcruise              # layering rules
pnpm format                 # prettier --write

pnpm --filter @portionium/api user create --email you@example.com \
  --name "Your Name" --timezone Europe/Berlin     # the first account, see Accounts
pnpm --filter @portionium/api backup create       # and `backup restore`, see Backups
pnpm --filter @portionium/api db:generate <name>  # after editing a schema file
pnpm --filter @portionium/api openapi             # after changing a route contract
pnpm --filter @portionium/web e2e                 # builds the client, then Playwright
```

Or in a container, which is what a deployment runs:

```sh
docker compose up -d          # http://localhost:8080, migrations and seed included
```

## Layout

Three pnpm workspaces: `api`, `web` and `packages/*`.

```
api/                @portionium/api, the Fastify server
  src/domain/       entities, services, pure logic, no framework imports
  src/db/           Drizzle schema, migrations, repositories
  src/http/         Fastify app, plugins, routes
  src/cli/          account administration and backups
  test/             integration tests that need a database
  test/helpers/     the test database, the factories and the frozen clock
  drizzle/          generated migration files, committed
  openapi/          the generated spec, committed as the contract snapshot
  seed/             the food catalog that ships with the app, committed
web/                @portionium/web, the PWA, Vite and React
  src/              app code
  e2e/              Playwright specs, run against a freshly seeded API instance
  public/           icons and anything else copied into the bundle as it stands
packages/schemas/   @portionium/schemas, Zod schemas shared by both apps
docs/adr/           architecture decision records
docs/runbooks/      operational procedures
docs/evals/         prompt golden sets and eval results, committed
```

`@portionium/schemas` is consumed over the `workspace:` protocol and its `exports` point at
TypeScript source, not build output, so there is no build step between editing a schema and both
sides seeing it. Plain `node` cannot load that, which is why the container ships the package's
`dist/` build instead. See the Dockerfile.

**Layering inside `api`.** `domain` imports nothing from `db`, `http`, and no framework or database
library. `db` may import `domain` and is the only place Drizzle appears. `http` and `cli` may
import `domain` and `db`, hold no business logic, and never import each other.

**Layering between workspaces.** `packages/schemas` imports Zod and nothing else. `web` may import
`@portionium/schemas` and never anything from `api`; the two talk over HTTP. `api/src/domain` may
import `@portionium/schemas`.

[`.dependency-cruiser.cjs`](./.dependency-cruiser.cjs) is the source of truth and CI fails on
violations.

## Rules

- Every user owned table carries `user_id`. Every repository read takes a `userId`. No exceptions.
- IDs are UUIDv7. Timestamps are UTC. Local dates go through `resolveLocalDate` and nothing else,
  see [ADR 002](./docs/adr/002-local-day-boundaries.md).
- Domain errors are typed. HTTP mapping happens in exactly one place.
- ESM throughout. In `api` and `packages/schemas`, relative imports carry explicit `.js`
  extensions, as NodeNext requires. `web` omits them (`moduleResolution: Bundler`). No path aliases
  in either: a relative path makes a layering violation visible in the import itself.
- Unit tests are `*.test.ts` next to the code. Tests that need a database live in `api/test/`.
- Exact dependency versions, the lockfile is committed.

## Comments

A comment earns its place only by saying something the code cannot: how an external system behaves,
a constraint a reasonable change would break, why a magic number is that number, why an omission is
deliberate. Everything else is deleted rather than reworded.

- Never restate the code. No JSDoc that repeats a signature, no comment above a function, class,
  component, hook or variable that names it again.
- Never narrate. A block of code gets no running commentary, and a file gets no opening essay.
- Architecture goes in `docs/adr/`, not inline. Cite an ADR only where the code reads wrong without
  it, and once, not at every site that touches the decision.
- One or two lines, factual, written for someone who can already read the code. Longer than that
  means it belongs in an ADR, or nowhere.
- Same bar in tests. Prefer a descriptive test name; comment only a genuinely counterintuitive case
  or a workaround the environment forces.
- No Jira keys in source, comments and test names included. A commit message may name the story in
  words.
- Do not add a comment because a function is long, public or complex. If the code needs explaining,
  rename or restructure it first.

Adding a comment needs a reason a reviewer would accept out loud. "It explains what the code does"
is not one.

## HTTP

[`api/src/http/app.ts`](./api/src/http/app.ts) builds the Fastify instance. `buildApp()` returns a
server that has not listened yet, so tests get the real application over `app.inject()`.
[`api/src/index.ts`](./api/src/index.ts) is the only place that listens.

### Writing a route

Copy [`api/src/http/routes/auth.ts`](./api/src/http/routes/auth.ts). A route declares Zod schemas
and nothing else; `fastify-type-provider-zod` infers the handler's types from them.

- Declare a schema for whichever of `params`, `querystring` and `body` the route takes, and for
  every status it answers with. Responses are serialized through their schema, so a handler
  returning an undeclared field fails in the test suite rather than in a client.
- Request schemas are strict, bodies and query strings alike: `z.strictObject` in
  `@portionium/schemas`, held to it by a test there.
- Spread `problemResponses` into the `response` map. Routes that change something also spread
  `idempotencyProblemResponses`.
- Declare `config: { auth: 'read' | 'write' | 'admin' | 'public' }`. A route that declares nothing
  throws at registration.
- Register inside the `API_PREFIX` block. A future v2 is a second `register` call there.
  `GET /health` and `GET /ready` stay outside it: an orchestrator is not tracking API versions.

### Errors

Every non 2xx response is RFC 9457 Problem Details, served as `application/problem+json`. The wire
shape and the list of types live in
[`packages/schemas/src/problem.ts`](./packages/schemas/src/problem.ts) because clients branch on
`type`; what each failure means over HTTP lives in
[`api/src/http/problem.ts`](./api/src/http/problem.ts) and nowhere else.

**Adding a domain failure is two edits**: the code in
[`api/src/domain/errors.ts`](./api/src/domain/errors.ts) and its entry in `DOMAIN_PROBLEMS`. The map
is a `Record` over the code union, so the first without the second does not compile. The domain
never names a status code.

An unexpected exception answers 500 with a fixed sentence; the stack goes to the log. Every problem
carries `requestId`, which Fastify generates and never reads from a request header.

### Idempotent writes

Every authenticated `POST`, `PUT`, `PATCH` and `DELETE` accepts an `Idempotency-Key` header, handled
in [`api/src/http/plugins/idempotency.ts`](./api/src/http/plugins/idempotency.ts). Why, and what was
rejected, is [ADR 004](./docs/adr/004-idempotency-keys.md). Rows are purged hourly once older than
`IDEMPOTENCY_RETENTION_HOURS`.

### Pagination

Two query parameters, `limit` and `cursor`, and one envelope, `{ items, nextCursor }`, written down
in [`packages/schemas/src/api.ts`](./packages/schemas/src/api.ts). Cursor based, not offset based:
rows here are written continuously and an offset would repeat or skip one. A cursor is opaque;
`nextCursor` is null on the last page rather than absent.

### Rate limiting, headers and CORS

Three hooks on the root instance, registered before the auth plugin so no route opts in or out.

- **Rate limiting** is counted per minute in three buckets, read, write and auth, because the three
  cost the server different things. Every request is counted against both the credential hash and
  the caller's address, and both have to be under the limit. `GET /health` is never limited. Why the
  counters are in process memory is [ADR 005](./docs/adr/005-no-redis-no-metrics-stack.md).
- **Security headers** live in
  [`api/src/http/plugins/security.ts`](./api/src/http/plugins/security.ts) and nowhere else. The
  Swagger UI and the web client each get their own CSP rather than an exemption.
- **CORS is off** unless `CORS_ORIGINS` lists exact origins. There is no wildcard: every response
  here is credentialed.

### OpenAPI

Generated from the same schemas the routes are validated with, served at `GET /api/v1/openapi.json`,
with Swagger UI at `/api/v1/docs` behind `API_DOCS_ENABLED`. There is no hand written spec and there
will not be one.

The document is also committed at [`api/openapi/openapi.json`](./api/openapi/openapi.json) and
compared against the live one by `api/test/http/openapi-snapshot.test.ts`, so a contract change is a
visible diff in the commit that causes it. Regenerate with
`pnpm --filter @portionium/api openapi`, which is `vitest -u` over that same test.

There is no generated client. `web` imports its types from `@portionium/schemas`, which is the
definition the server validates with, so a contract change breaks the typecheck on both sides in one
commit.

### Serving the web client

When `WEB_ROOT` names a directory, this process serves the built client on the origin it already
answers on. Empty by default, so development and every test serve the API alone.

It is served from the **not found handler**, in
[`api/src/http/plugins/static.ts`](./api/src/http/plugins/static.ts), never as a wildcard route: a
wildcard at the root would claim `/api/v1/mistyped` and answer the app shell where this API owes a
problem document. Four answers, in order: a path under `/api/v1` is declined; a path naming a real
file is that file; a path that looks like a file and is not one is a 404; anything else is the app
shell.

Cache headers are two answers. Anything under `assets/` is `immutable` for a year, safe only because
Vite content hashes those names. Everything else, the shell and the service worker included, is
`no-cache`.

### Logging

Pino, one JSON object per line on stdout at `LOG_LEVEL`. Every request gets an id and a child logger
bound to it, and that id is in the body of every error response.

What a line may never carry is in [`api/src/http/logging.ts`](./api/src/http/logging.ts) as Pino
redaction paths, not at the call sites: passwords, tokens, addresses in full, and the content of any
prompt sent to a model. Startup logs the resolved configuration with any value whose key names a
secret replaced, so a key added later is masked without anybody remembering.

`GET /health` is liveness and does not touch the database. `GET /ready` is readiness and does.
Neither needs a credential, neither carries a version, neither is rate limited.

## Authentication

Accounts are made by an administrator. There is no public registration endpoint and self service
sign up is out of scope.

### Passwords and sessions

Argon2id at OWASP's current parameters, written out in `ARGON2_OPTIONS` in
[`api/src/domain/auth.ts`](./api/src/domain/auth.ts) rather than left to the library's defaults.

`POST /api/v1/auth/login` answers a wrong password and an unknown address identically. Two things
keep that true and both are easy to undo by accident: the handler always runs a real Argon2
verification, against the account's hash or `DUMMY_PASSWORD_HASH`, and failed attempts are counted
whether or not the account exists.

| Key   | Failures | Window     | Effect                           |
| ----- | -------- | ---------- | -------------------------------- |
| Email | 5        | 15 minutes | 429 for that address from any IP |
| IP    | 20       | 15 minutes | 429 for any address from that IP |

The window starts at the first failure and does not move. A successful login clears the address,
never the IP.

A login sets `portionium_session`, an `HttpOnly` cookie carrying an opaque token. The token is never
in the response body, and the row stores a SHA-256 of it. Cookie attributes are written down once,
in `sessionCookie` in [`api/src/http/plugins/auth.ts`](./api/src/http/plugins/auth.ts); `Secure`
follows `WEB_ORIGIN`'s scheme, not `NODE_ENV`. Expiry slides: `SESSION_TTL_DAYS` is an idle timeout,
and the write is throttled to one a minute per session.

### CSRF

A mutating request authenticated by the cookie must carry an `Origin` header equal to `WEB_ORIGIN`.
A missing header is refused rather than trusted. Safe methods are exempt, and so are bearer
requests, because nothing attaches a bearer header on a page's behalf.

### API tokens

`POST /auth/tokens` mints one, `GET /auth/tokens` lists them without the tokens,
`DELETE /auth/tokens/:id` revokes one. Four rules are deliberate:

- The plaintext exists in one response, once. Only the digest is stored.
- Tokens wear `prt_`, so secret scanners can recognise them and the request path knows which table
  to read.
- A token cannot mint a token, end a session or change a password: those answer
  `SessionRequiredError`.
- Requested scopes are checked against the user's role at creation and intersected with it on every
  request, so demoting an account narrows the tokens it already issued.

Revoking sets `revoked_at` and keeps the row. Changing a password ends every session and
deliberately leaves tokens alone.

### Authorization

Identity is established in one place,
[`api/src/http/plugins/auth.ts`](./api/src/http/plugins/auth.ts). Why the design looks like this is
[ADR 003](./docs/adr/003-multi-user-authorization.md). Four rules, each enforced rather than
remembered:

- Every route declares who may call it, or the server does not start.
- The public surface is a list in `api/test/http/authorization.test.ts`, compared against the routes
  actually registered, so a fourth public endpoint is a visible line in a diff.
- `request.auth` is the only source of a user id. Never take one from a body, a query string or a
  path segment.
- A row belonging to somebody else is a 404, never a 403. 403 is for `InsufficientScopeError` alone.

### Accounts

There is no HTTP endpoint for making accounts: being on the machine with the database file is the
authorisation, the same authorisation restoring a backup needs.

```sh
pnpm --filter @portionium/api user create --email a@b.de --name "Ada" --timezone Europe/Berlin
pnpm --filter @portionium/api user passwd --email a@b.de
pnpm --filter @portionium/api user revoke-tokens --email a@b.de
```

The first account on a fresh instance is an admin unless `--role` says otherwise. The password is
never an argument: it is typed at a prompt that does not echo, or piped in.

Over HTTP the account is three endpoints in
[`api/src/http/routes/me.ts`](./api/src/http/routes/me.ts) and no id in any path. `PATCH /me` changes
the display name, timezone and day boundary hour and has no field for an email or a role.
`POST /me/password` requires the current password, answers 403 rather than the login's 401 when it
is wrong, and cannot be called with a token.

## Database

One SQLite file, opened in exactly one place, [`api/src/db/client.ts`](./api/src/db/client.ts). Why
SQLite, and what would change our minds, is [ADR 001](./docs/adr/001-sqlite-over-postgresql.md).

Every table spreads `baseColumns` from [`api/src/db/schema/base.ts`](./api/src/db/schema/base.ts):
`id` (UUIDv7), `created_at`, `updated_at`, `deleted_at`. One schema file per table.

One `food` table holds ingredients, dishes and branded products alike, with no recipe table and no
composition: [ADR 006](./docs/adr/006-single-foods-table.md).

### Changing the schema

```sh
pnpm --filter @portionium/api db:generate add_meal_table
```

Edit the schema file, then generate. The name is not optional: without it you get
`0007_flowery_micromacro.sql` and nobody reviewing the diff in a year can tell what it did. Use
`snake_case` and describe the change, not the ticket.

Generated SQL goes to `api/drizzle/`, is committed, and is applied by `openDatabase()` at startup
rather than by a separate deploy step.

**A migration that has been applied anywhere is frozen.** Never edit it, never renumber it, never
delete it. Fix it forward.

There are no down migrations. The recovery path is to restore the database file from backup and
redeploy the previous release, which is why a migration that drops or rewrites data is worth a
second pair of eyes.

### Backups

[`api/src/db/backup.ts`](./api/src/db/backup.ts), and one rule decides everything in it: a running
SQLite database in WAL mode is not its file, so `cp` copies a prefix of the truth. A backup here is
`VACUUM INTO`, which writes a complete, freshly packed database with no sidecars.

Archives are gzipped and named `portionium-<UTC timestamp>.db.gz`. The timestamp is in the name
because an mtime does not survive a copy to object storage, and it is what the retention policy
reads. A file this module did not name is ignored and never deleted. Retention is
grandfather-father-son, and an archive counts in every tier it is the newest of.

The schedule is in `index.ts` rather than a plugin, so a test that builds an app does not start
writing files. It runs at startup and hourly; `createBackupIfDue` is what stops a restart taking a
second backup. Off when `BACKUP_DIR` is empty, said out loud at warn.

`restoreBackup` removes the target's `-wal` and `-shm`, runs `integrity_check`, and opens the result
the way the application does. An existing target is refused unless `--force`.

```sh
pnpm --filter @portionium/api backup create
pnpm --filter @portionium/api backup list
pnpm --filter @portionium/api backup restore --from data/backups/portionium-...db.gz
```

The `restore` job in CI runs these same documented commands on every push, so a broken command fails
there rather than in an incident. An off-machine copy is `rclone` or `restic` on a timer and is
deliberately not code; see [docs/runbooks/backup.md](./docs/runbooks/backup.md).

### Seed catalog

[`api/seed/foods.json`](./api/seed/foods.json) is the catalog that ships with the app, roughly 240
entries weighted towards German everyday eating. It is product data, not test data: a good catalog
means the AI classifier is rarely reached.

Colour is energy density **as the food is eaten**, not as it is sold. Green under roughly
120 kcal/100 g, yellow up to roughly 250, orange above. Drinks are judged by what a normal glass
delivers, because a cola is 42 kcal/100 ml and still a glass of sugar. Nuts and oils come out
orange, which is the honest answer an energy density model gives. The rule is repeated at the top of
the JSON file, because that is where it gets ignored.

`seedFoodCatalog()` runs at startup after the migrations and compares the file against the database
on every run, so adding entries and restarting is the whole deployment step. It leaves a soft
deleted seed food deleted and does not move a colour that changed in the file: correcting a shipped
verdict is a deliberate act.

### Classifications

A food has no colour. It has a stack of opinions about its colour, and
[`api/src/db/classification.ts`](./api/src/db/classification.ts) is the log of them. Nothing updates
a row and nothing deletes one; the module exposes one write and it inserts. Why, and what it costs
on every read, is [ADR 007](./docs/adr/007-append-only-classification-log.md).

Which verdict wins is `resolveClassification` in
[`api/src/domain/classification.ts`](./api/src/domain/classification.ts), and every path that asks
what colour a **food** is goes through it.

It does not answer what colour an **entry** is. An entry carries a `category` stamped when it was
logged and no read recomputes it, which is [ADR 011](./docs/adr/011-an-entry-is-a-colour.md).
Resolution therefore belongs to the preset half of the application only: food search, the review
queue, the `foods` list on a day, the favourite and suggestion previews. Reaching for it to draw a
logged entry is the bug that ADR exists to remove.

### Search

`GET /api/v1/foods/search?q=` is the endpoint the core interaction sits on, and its two halves are
deliberately in different places.

**Recall** is SQLite FTS5 in a trigram-tokenised virtual table, kept in step with `food` by triggers
added in [`0005_add_food_search_index.sql`](./api/drizzle/0005_add_food_search_index.sql), so
nothing in TypeScript writes to the index. **Ranking** is
[`api/src/domain/food-search.ts`](./api/src/domain/food-search.ts), in memory: exact match, then the
caller's own most recently eaten foods, then instance-wide frequency, then lexical relevance. The
second key is the one that matters.

Two things the index cannot do fall through to a scan of the live names, and only when the index
returned less than a full page: a query under three characters, and a typo. An empty `q` is not an
error; it answers with the caller's most eaten foods.

`api/test/food-search.test.ts` holds the benchmark: 5000 entries, median under 50 ms. It is there to
catch a change of kind, not to police a millisecond.

### Tests

`createTestDatabase()` in [`api/test/helpers/database.ts`](./api/test/helpers/database.ts) gives a
fresh migrated database in its own temp directory, on a real file rather than `:memory:` because WAL
and the busy timeout only mean anything for one.

`createTestFixtures()` adds two accounts, `userA` and `userB`, plus `create`, the row factories. Two
accounts because almost every read takes a `userId` and a test with one user cannot tell a query
that filters by owner from one that forgot to. They sit in different timezones on purpose. The
factories build rows the way the application does, so a suite cannot pass against rows the
application could never produce.

`freezeTime()` pins the clock and restores it on its own. Only `Date` is faked, not timers.

Coverage is `pnpm test:coverage`, targeting 80 percent of `api/src/domain` and `api/src/db`. There
is no threshold and CI does not fail on the number, on purpose: the useful line is a module showing
up as a row of zeroes, not the percentage at the bottom.

## Web client

React and Vite, installable as a PWA, served in production by the API process on its own origin.
There are no hand written request or response types: everything on the wire comes from
`@portionium/schemas`.

### Talking to the API

One function, `request` in [`web/src/api.ts`](./web/src/api.ts), and every call goes through it. The
response is parsed with the route's schema rather than cast to it. A non 2xx is an `ApiError`
carrying the problem document whole, so a caller branches on `problem.type` from the same union the
API is built from. `problem.detail` is the only part safe to show a person.

Neither credential nor CSRF header appears in that file and both are handled: the session cookie is
`HttpOnly` and the browser attaches it because the request goes to the origin the app was served
from. `credentials` is `same-origin`, because a cross origin request from this client is a bug.

An unauthenticated response fires `UNAUTHENTICATED_EVENT`; `App` listens and renders the login
screen. Nothing stored is cleared, so a queue of meals written on a train survives signing back in.

### The device, and the outbox

One IndexedDB database, opened in [`web/src/db.ts`](./web/src/db.ts) through Dexie. Four tables:
`days` (cold launch renders something), `foods` (logging works with no network, since a meal
references a food by id), `stats`, and `outbox`.

Reads are cache first and then replaced. **The server is the source of truth for every read, without
exception**, which is what keeps this a cache rather than a replica. Cached rows are parsed on the
way out, not cast, so a row written by an older version of the app is a miss rather than a crash.

The outbox is [`web/src/outbox.ts`](./web/src/outbox.ts). It is one directional and it is not a sync
engine; the reasoning is [ADR 010](./docs/adr/010-pwa-and-offline-outbox.md). Two things to know
before changing it: `classifyAttempt` is the only piece of judgement in the module, and
`localDateFor` is the client side twin of `resolveLocalDate` and has to agree with it, or an offline
meal is filed under one date locally and another on the server.

### Screens

[`web/src/today.tsx`](./web/src/today.tsx) is the screen the app opens on;
[`web/src/day.ts`](./web/src/day.ts) is the arithmetic behind it, split out because none of it needs
React. [`web/src/stats.ts`](./web/src/stats.ts) is the same split for
[`web/src/statistics.tsx`](./web/src/statistics.tsx).

Rules that outlive any one screen:

- **There is no loading state anywhere**, deliberately. A day is read from the device and rendered,
  and the server's answer replaces it whenever it arrives.
- **A dot reads `entry.category` and nothing else.** Nothing on a day screen resolves a colour.
- **The trend is the headline and a daily weight is never the largest thing on screen.** When the
  server says there is too little evidence, the line is not drawn at all.
- **Nothing here recomputes a statistic.** The server smooths the trend
  ([ADR 008](./docs/adr/008-weight-trend-smoothing.md)); a second implementation on this side would
  be a second answer to one question.
- **There is no quantity field and there will not be one.** `entrySchema.quantity` exists on the
  wire and stays unused. The moment portions become enterable this turns back into the calorie
  tracker it exists to replace.
- Hue alone separates the four states on screen, so `aria-label` is the only channel a colour blind
  reader has. If a second visual channel is ever restored it belongs in `DOTS` in
  [`web/src/dot.tsx`](./web/src/dot.tsx), which every surface reads.

The composer, [`web/src/compose.tsx`](./web/src/compose.tsx), is the interaction the product lives or
dies on, and everything in it is arranged around the taps between opening the app and a logged three
item meal. The search field is an ARIA combobox over a listbox; focus never leaves the input.
Answers come from the device first and the server second, in one effect whose cleanup covers both a
request per keystroke and an out of order answer.

### One origin, and the build

In development the client runs on the Vite dev server and `server.proxy` sends `/api` to the local
Fastify instance, so the browser sees one origin. In production the API serves the built bundle.
`WEB_ORIGIN` has to name whatever the browser sees; its scheme also decides whether the session
cookie is marked `Secure`.

`vite-plugin-pwa` in generate mode, `registerType: 'autoUpdate'`. What makes that safe is the cache
headers the API serves the bundle with. `navigator.storage.persist()` is requested once at startup,
or a browser under storage pressure may evict a queue of meals somebody logged offline.

### The design system

Tailwind v4 through `@tailwindcss/vite`, which is the whole of its configuration: v4 reads the theme
out of the stylesheet and finds class names by scanning, so there is no `tailwind.config.js` and no
PostCSS config. [`web/src/styles.css`](./web/src/styles.css) is the system: `@theme` for the palette
and `--spacing-touch`, `@layer base` for what a bare `button`, `input`, `main` or heading looks like,
and two `@utility` rules, `row` and `primary`.

A scale rather than a component library. Light and dark follow the system setting through
`color-scheme` and `light-dark()`; there is no toggle and no stored preference. Icons are
`lucide-react`, imported by name at each use.

### Tests

Unit tests are `*.test.ts` beside the code; `vite.config.ts` limits Vitest's `include` to `src/`
because Playwright names its files the same way.

Browser tests are in `web/e2e/`, configured by
[`web/playwright.config.ts`](./web/playwright.config.ts), which is the harness: it deletes the
temporary database, creates the accounts through the `user` CLI, and starts the API with `WEB_ROOT`
pointing at the bundle just built, in one shell. One origin rather than the dev server with a proxy,
because the two things worth testing end to end are exactly the two a second origin changes: the
`SameSite=Lax` cookie and the `Origin` check.

**One account per spec file**, `ACCOUNTS`. Spec files run in parallel and everything they write lands
on today, so a shared account makes one spec's rows visible to another's locators. Claiming a meal
type still applies inside a file.

Installability is checked by hand against a deployed instance with Lighthouse, not in CI.

## Containers

One image holds the compiled API, its production dependencies and `web/dist`, and the API serves all
three. [`Dockerfile`](./Dockerfile) is three stages and runs as `node`, uid 1000. Migrations and the
catalog are applied at startup, so starting the container is the whole deployment step. The database
is at `/data`, a volume in both the Dockerfile and the Compose file. The image declares its own
`HEALTHCHECK`, so a plain `docker run` gets it too.

[`docker-compose.yml`](./docker-compose.yml) needs no editing for a first run: settings go in an
optional `.env.docker`, and a `caddy` profile adds a reverse proxy with automatic TLS, which is not
optional for a PWA on a domain. Hosting is [ADR 009](./docs/adr/009-hosting-and-deployment.md).

The CI limit on the unpacked image is 215 MiB, measured by reading the unpacked filesystem because
`docker image inspect .Size` reports different things on the two image stores. The `image` job
builds, asserts the size, starts the container and checks what it serves; a change here is not done
until it is green.

## Writing changes

- Work lands directly on `main`. One developer, so a pull request would be a review with nobody to
  review it, and CI runs on every push regardless. Conventional commit messages, tests accompany
  every behaviour change.
- ADRs live in [`docs/adr/`](./docs/adr/). A story with an ADR criterion is not done until the ADR
  exists. Put the reasoning there, not in a comment and not in this file.
- No em dashes in documentation or generated text. Use commas or sentence breaks.

## Toolchain note

TypeScript is pinned to 6.x. TypeScript 7 is the native compiler and its API is not published yet,
so `typescript-eslint` and `dependency-cruiser` cannot read it. Bump both together once they support
7, and confirm `pnpm depcruise` still reports a non zero module count.
