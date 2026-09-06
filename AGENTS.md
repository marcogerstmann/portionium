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
  drizzle/          generated migration files, committed
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

### Tests

`createTestDatabase()` in [`api/test/helpers/database.ts`](./api/test/helpers/database.ts) gives a
fresh migrated database in its own temp directory. `close()` drops the connection and the
directory. It uses a file rather than `:memory:`, because WAL and the busy timeout only mean
anything for a real file.

## Writing changes

- One pull request per story, conventional commit messages, tests accompany every behaviour change.
- Do not reference Jira keys in code comments or identifiers. Keys change, code should read on its
  own. Commit messages may name the story in words.
- ADRs live in [`docs/adr/`](./docs/adr/). A story with an ADR criterion is not done until the ADR
  exists.
- No em dashes in documentation or generated text. Use commas or sentence breaks.

## Toolchain note

TypeScript is pinned to 6.x. TypeScript 7 is the native compiler and its API is not published yet,
so `typescript-eslint` and `dependency-cruiser` cannot read it. Bump both together once they
support 7, and confirm `pnpm depcruise` still reports a non zero module count.
