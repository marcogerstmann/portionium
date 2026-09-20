# syntax=docker/dockerfile:1

# The API and the built web client in one image, served on one origin.

# Kept in step with .nvmrc.
ARG NODE_VERSION=24.18.0

FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# ---------------------------------------------------------------------------------------------

FROM base AS deps
# better-sqlite3's install script runs node-gyp unconditionally, prebuilt binaries or not.
RUN apk add --no-cache python3 make g++

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY api/package.json api/
COPY web/package.json web/
COPY packages/schemas/package.json packages/schemas/

# The trailing `...` is pnpm's "and its workspace dependencies": @portionium/schemas comes
# along, web's React does not.
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
RUN pnpm build

# ---------------------------------------------------------------------------------------------

FROM node:${NODE_VERSION}-alpine AS runtime
WORKDIR /app

# Enough for `docker run` with no environment at all. Compose puts an env_file in front.
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/data/portionium.db \
    BACKUP_DIR=/data/backups \
    WEB_ROOT=/app/web/dist \
    WEB_ORIGIN=http://localhost:8080

# Nothing here installs anything at runtime.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# pnpm links each project's node_modules into the root store, so the symlinks only resolve if
# all three arrive together.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/api/node_modules ./api/node_modules
COPY --from=deps /app/packages/schemas/node_modules ./packages/schemas/node_modules

# drizzle/ and seed/ are product data the process reads at startup, not build artefacts.
COPY --from=build /app/api/dist ./api/dist
COPY --from=build /app/api/drizzle ./api/drizzle
COPY --from=build /app/api/seed ./api/seed
COPY --from=build /app/api/package.json ./api/package.json
COPY --from=build /app/packages/schemas/dist ./packages/schemas/dist
COPY --from=build /app/web/dist ./web/dist

# Drops the prebuilds for the seven platforms this image will never run on, about a third of
# the dependency tree. `test -f` before the delete, so a prebuild renamed by a version bump
# fails the build here rather than shipping a container that cannot open its database.
RUN set -eu; \
    keep="linuxmusl-$(node -p 'process.arch').node"; \
    for pkg in node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3; do \
      test -f "$pkg/prebuilds/$keep"; \
      find "$pkg/prebuilds" -type f ! -name "$keep" -delete; \
      rm -rf "$pkg/deps" "$pkg/src" "$pkg/build"; \
    done

# The one thing this image spells differently from a checkout. The real manifest points
# `exports` at src/index.ts, which Node cannot load: type stripping does not remap the explicit
# `.js` specifiers NodeNext requires onto the .ts files they name. So the image names dist/.
RUN printf '%s' \
  '{"name":"@portionium/schemas","version":"0.0.0","type":"module",' \
  '"exports":{".":"./dist/index.js"}}' \
  > packages/schemas/package.json

# Declared here as well as in Compose, so `docker run` without a mount still writes somewhere
# that survives the container. Owned by `node`: Docker copies this ownership onto an empty
# named volume the first time it mounts one.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node

EXPOSE 3000

# Node rather than curl, which the base image does not have.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

WORKDIR /app/api
CMD ["node", "dist/index.js"]
