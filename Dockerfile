# syntax=docker/dockerfile:1

# The whole application in one image: the compiled API, which also serves the built web client
# on the origin it answers on. One container rather than two because the session cookie is
# SameSite=Lax and every write is checked against WEB_ORIGIN, so a client served from anywhere
# else needs CORS and a second origin configured before it can write anything at all.
#
# Three stages. `build` needs a compiler and the dev dependencies and keeps neither. `deps`
# resolves the production dependency tree on its own, so editing a source file does not
# reinstall it. `runtime` is assembled from the two and has no package manager in it.

# Pinned to the same version .nvmrc names, so the container and a developer's machine run one
# runtime. Alpine because the base layer is most of the size of an image this small.
ARG NODE_VERSION=24.18.0

FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Reads the pnpm version from the packageManager field, the same pin CI uses.
RUN corepack enable
WORKDIR /app

# ---------------------------------------------------------------------------------------------

FROM base AS deps
# better-sqlite3's install script runs node-gyp unconditionally, so a toolchain has to be here
# even though the package also ships prebuilt binaries. The compile writes its result into the
# package's own prebuilds/ directory alongside them. None of this reaches the runtime stage.
RUN apk add --no-cache python3 make g++

# The manifests before the sources, so a change to a source file does not reinstall anything.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY api/package.json api/
COPY web/package.json web/
COPY packages/schemas/package.json packages/schemas/

# Production dependencies only, and only the ones the API and what it imports actually need.
# The trailing `...` is pnpm's "and its workspace dependencies", which is how @portionium/schemas
# comes along and web's React does not.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @portionium/api...

# ---------------------------------------------------------------------------------------------

FROM base AS build
RUN apk add --no-cache python3 make g++

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY api/package.json api/
COPY web/package.json web/
COPY packages/schemas/package.json packages/schemas/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .
# tsc for the schemas and the API, Vite for the client. See the build script in each workspace.
RUN pnpm build

# ---------------------------------------------------------------------------------------------

FROM node:${NODE_VERSION}-alpine AS runtime
WORKDIR /app

# Defaults that make `docker run` with no environment at all a working instance. Compose puts
# an env_file in front of these, so overriding one is a line in a file rather than an edit here.
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/data/portionium.db \
    WEB_ROOT=/app/web/dist \
    WEB_ORIGIN=http://localhost:8080

# npm ships with the base image and nothing in here installs anything. Removing it is a dozen
# megabytes and one less thing that can be persuaded to fetch code at runtime.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# The dependency trees. pnpm links every project's node_modules into the store at the root, so
# the symlinks only resolve if all of them arrive together.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/api/node_modules ./api/node_modules
COPY --from=deps /app/packages/schemas/node_modules ./packages/schemas/node_modules

# The compiled application. drizzle/ is the migrations the process applies at startup and seed/
# is the food catalog it loads, so both are product data rather than build artefacts.
COPY --from=build /app/api/dist ./api/dist
COPY --from=build /app/api/drizzle ./api/drizzle
COPY --from=build /app/api/seed ./api/seed
COPY --from=build /app/api/package.json ./api/package.json
COPY --from=build /app/packages/schemas/dist ./packages/schemas/dist
COPY --from=build /app/web/dist ./web/dist

# better-sqlite3 arrives carrying the SQLite amalgamation it was built from, the node-gyp
# intermediates it left behind, and a prebuilt binary for each of eight platforms. This image
# runs on exactly one of those and compiles nothing, so the rest is a third of the dependency
# tree spent on nothing.
#
# `test -f` before the delete rather than after: it is the guard that turns a renamed prebuild
# on a version bump into a failed build here, instead of a container that cannot open its
# database. `set -eu` is what makes that test fatal.
RUN set -eu; \
    keep="linuxmusl-$(node -p 'process.arch').node"; \
    for pkg in node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3; do \
      test -f "$pkg/prebuilds/$keep"; \
      find "$pkg/prebuilds" -type f ! -name "$keep" -delete; \
      rm -rf "$pkg/deps" "$pkg/src" "$pkg/build"; \
    done

# The schemas package as a compiled dependency, which is the one thing this image spells
# differently from a developer's checkout.
#
# Its real manifest points `exports` at src/index.ts, and that is deliberate: both apps read one
# definition with no build step between editing a schema and seeing it. Node cannot load that
# file, though. Type stripping does not remap the explicit `.js` specifiers NodeNext requires
# onto the .ts files they name, so `node api/dist/index.js` against the source tree fails on the
# first relative import. tsc already emits the package to dist/ for exactly this case, so the
# image ships a manifest naming it. If this and the build ever disagree the container refuses to
# start, which is what the image smoke test in CI is there to catch.
RUN printf '%s' \
  '{"name":"@portionium/schemas","version":"0.0.0","type":"module",' \
  '"exports":{".":"./dist/index.js"}}' \
  > packages/schemas/package.json

# The database lives on a volume and never in a layer. Declared here as well as in Compose, so
# `docker run` without a mount still writes somewhere that survives the container rather than
# quietly filling the writable layer with the only copy of somebody's data.
#
# Owned by the unprivileged user the process runs as: Docker copies this directory's ownership
# onto an empty named volume the first time it mounts one.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

# node, uid 1000, ships with the base image. Nothing here needs root and the process writes
# only to /data.
USER node

EXPOSE 3000

# The container reports its own state, so an orchestrator restarts a wedged process without
# being told how to ask. /health is liveness only and never rate limited, see routes/health.ts.
# Written in Node rather than with curl because the base image has no curl and this needs no
# shell, so PORT is read rather than interpolated.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

WORKDIR /app/api
# Migrations and the seed catalog run inside this, before the listener opens. See src/index.ts.
CMD ["node", "dist/index.js"]
