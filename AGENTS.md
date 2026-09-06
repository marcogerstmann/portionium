# AGENTS.md

Read this before changing anything. Conventions live here so they are not re-explained per ticket.

## Local setup

Node comes from `.nvmrc`, pnpm from the `packageManager` field via Corepack (`corepack enable`).

```sh
pnpm install
cp .env.example .env
pnpm dev                    # api in watch mode
pnpm build                  # tsc to api/dist
pnpm test                   # vitest
pnpm typecheck              # tsc --noEmit
pnpm lint                   # eslint + prettier --check
pnpm depcruise              # layering rules
pnpm format                 # prettier --write
```

## Layout

```
api/            @portionium/api, the only pnpm workspace package
  src/domain/   entities, services, pure logic, no framework imports
  src/db/       Drizzle schema, migrations, repositories
  src/http/     Fastify app, plugins, routes
  src/mcp/      MCP adapter over the domain services
  test/         integration tests that need a database
  drizzle/      generated migration files, committed
android/        Gradle project, not a pnpm workspace
docs/adr/       architecture decision records
docs/evals/     prompt golden sets and eval results, committed
```

Layering: `domain` imports nothing from `db`, `http`, `mcp` and no framework or database
library. `db` may import `domain` and is the only place Drizzle appears. `http` and `mcp` may
import `domain` and `db`, hold no business logic, and never import each other.
[`.dependency-cruiser.cjs`](./.dependency-cruiser.cjs) is the source of truth and CI fails on
violations.

## Rules

- Every user owned table carries `user_id`. Every repository read takes a `userId`. No exceptions.
- IDs are UUIDv7. Timestamps are UTC. Local dates go through the one domain function for it.
- Domain errors are typed. HTTP mapping happens in exactly one place.
- ESM throughout. Relative imports carry explicit `.js` extensions, as NodeNext requires.
  No path aliases, a relative path makes a layering violation visible in the import itself.
- Unit tests are `*.test.ts` next to the code. Tests that need a database live in `api/test/`.
- Exact dependency versions, the lockfile is committed.

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
