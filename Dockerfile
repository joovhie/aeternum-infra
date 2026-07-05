# Dockerfile — Aeternum Keeper Bot
# Single-stage build: avoids broken pnpm workspace symlinks across stages.
# Build context: monorepo root (required for workspace package resolution).

FROM node:22-alpine

RUN npm install -g pnpm

WORKDIR /app

# --- Copy workspace manifests first for better layer caching ---
# pnpm needs all package.json files before running install so it can
# create correct workspace symlinks in node_modules.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/config/package.json ./packages/config/
COPY packages/blockchain/package.json ./packages/blockchain/
COPY packages/db/package.json ./packages/db/
COPY apps/keeper/package.json ./apps/keeper/

# --- Install all workspace dependencies ---
RUN pnpm install --frozen-lockfile

# --- Copy source files ---
COPY tsconfig.json ./
COPY packages/ ./packages/
COPY apps/keeper/ ./apps/keeper/

# --- Build shared packages then the keeper (dependency order matters) ---
RUN pnpm --filter @aeternum/config build && \
    pnpm --filter @aeternum/blockchain build && \
    pnpm --filter @aeternum/db build && \
    pnpm --filter @aeternum/keeper build

EXPOSE 3001

CMD ["node", "apps/keeper/dist/index.js"]