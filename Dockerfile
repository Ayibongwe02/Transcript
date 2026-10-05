# syntax=docker/dockerfile:1.7
#
# Multi-stage production image for Knowledge Hub
# (TanStack Start + Vite + Nitro "node-server").
#
# Auth / DB:
#   Prefer DATABASE_URL (Postgres). Without it the image falls back to embedded
#   PGLite, persisted at PGLITE_DATA_DIR (volume this path).
#   On start the entrypoint applies migrations/*.sql when DATABASE_URL is set
#   (so Better Auth's user/session tables exist before the first signup).
#
# Build:
#   docker build -t knowledge-hub .
#
# Run (recommended — real Postgres):
#   docker run --rm -p 10000:10000 \
#     -e DATABASE_URL="postgres://user:pass@host:5432/db" \
#     -e BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
#     -e BETTER_AUTH_URL="http://localhost:10000" \
#     knowledge-hub
#
# Run (PGLite fallback — no external DB; mount a volume to keep accounts):
#   docker run --rm -p 10000:10000 \
#     -e BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
#     -e BETTER_AUTH_URL="http://localhost:10000" \
#     -v kh_pglite:/app/data/pglite \
#     knowledge-hub

ARG NODE_VERSION=22-bookworm-slim

################################################################################
# deps
################################################################################
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
RUN corepack disable 2>/dev/null || true

COPY package.json ./
COPY package-lock.json* pnpm-lock.yaml* yarn.lock* .npmrc* ./

RUN --mount=type=cache,target=/root/.npm \
    set -eux; \
    if [ -f package-lock.json ]; then npm ci; \
    else npm install; \
    fi; \
    # Soft-check: npm may omit binary payloads on some mirrors; vendor/ covers it.
    if [ ! -f node_modules/@electric-sql/pglite/dist/pglite.data ]; then \
      echo "WARN: pglite.data missing from node_modules after npm ci — vendor/ will be used"; \
    fi

################################################################################
# build
################################################################################
FROM node:${NODE_VERSION} AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY package-lock.json* pnpm-lock.yaml* yarn.lock* .npmrc* ./
COPY tsconfig.json vite.config.ts vercel.json ./
COPY public ./public
COPY scripts ./scripts
COPY server ./server
COPY src ./src
COPY migrations ./migrations
COPY vendor ./vendor
COPY .grok/app-env.json ./.grok/app-env.json

# node-server preset (not Vercel). Auth is ON unless VITE_AUTH_ENABLED=false.
ENV NODE_ENV=production \
    NITRO_PRESET=node-server \
    NODE_OPTIONS=--max-old-space-size=4096

# build:node runs vite build then scripts/copy-pglite-assets.mjs
# (prefers node_modules, falls back to vendor/pglite).
RUN set -eux; \
    test -f vendor/pglite/pglite.data; \
    test -f vendor/pglite/pglite.wasm; \
    test -f vendor/pglite/initdb.wasm; \
    # Must be node-server — Vercel preset emits a Lambda handler that cannot stay up.
    export NITRO_PRESET=node-server; \
    echo "NITRO_PRESET=$NITRO_PRESET"; \
    npm run build:node; \
    test -f .output/server/index.mjs; \
    # Fail the image build if we accidentally got a Vercel handler.
    if grep -qE '@vercel/node|exports\.handler' .output/server/index.mjs 2>/dev/null; then \
      echo "FATAL: .output/server/index.mjs looks like a Vercel Lambda handler"; \
      head -c 2000 .output/server/index.mjs; \
      exit 1; \
    fi; \
    test -f .output/server/_libs/pglite.data; \
    test -f .output/server/_libs/pglite.wasm; \
    test -f .output/server/_libs/initdb.wasm; \
    ls -lh .output/server/_libs/pglite.* .output/server/_libs/initdb.wasm; \
    ls -lh .output/server/index.mjs

################################################################################
# runtime
################################################################################
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=10000 \
    NITRO_HOST=0.0.0.0 \
    NITRO_PORT=10000 \
    PGLITE_DATA_DIR=/app/data/pglite \
    HUB_UID=1001 \
    HUB_GID=1001

RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs --create-home hub \
    && mkdir -p /app/data/pglite /app/scripts /app/migrations \
    && chown -R hub:nodejs /app/data

# pg is only needed so scripts/migrate.mjs can apply the auth schema against
# a real Postgres. The Nitro bundle already contains its own traced copy for
# the app itself; this install keeps the entrypoint's migrator working.
RUN npm install --omit=dev --no-package-lock --prefix /app pg@8.16.3 \
    && rm -f /app/package.json /app/package-lock.json \
    && chown -R hub:nodejs /app/node_modules

COPY --from=build --chown=hub:nodejs /app/.output ./.output
COPY --from=build --chown=hub:nodejs /app/package.json ./package.json
COPY --from=build --chown=hub:nodejs /app/migrations ./migrations
COPY --from=build --chown=hub:nodejs /app/scripts/migrate.mjs ./scripts/migrate.mjs
COPY --from=build --chown=hub:nodejs /app/scripts/migration-plan.mjs ./scripts/migration-plan.mjs
COPY --from=build --chown=root:root /app/scripts/docker-entrypoint.mjs ./scripts/docker-entrypoint.mjs

# Entrypoint starts as root so it can chown a named volume, then drops to uid 1001.
EXPOSE 10000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "const p=process.env.PORT||10000;fetch('http://127.0.0.1:'+p+'/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "scripts/docker-entrypoint.mjs"]
