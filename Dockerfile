# =============================================================================
# Dockerfile.keeper
# Build context: monorepo root (required for workspace package resolution)
# =============================================================================

FROM node:22-alpine AS builder

RUN npm install -g pnpm

WORKDIR /app

# ── Copy workspace manifests first for better layer caching ──────────────────
# pnpm needs all package.json files before running install so it can
# create the correct workspace symlinks in node_modules.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/config/package.json ./packages/config/
COPY packages/blockchain/package.json ./packages/blockchain/
COPY packages/db/package.json ./packages/db/
COPY apps/keeper/package.json ./apps/keeper/

# ── Install all workspace dependencies ───────────────────────────────────────
RUN pnpm install --frozen-lockfile

# ── Copy source files ─────────────────────────────────────────────────────────
COPY tsconfig.json ./
COPY packages/ ./packages/
COPY apps/keeper/ ./apps/keeper/

# ── Build shared packages then the keeper (dependency order matters) ─────────
RUN pnpm --filter @aeternum/config build && \
    pnpm --filter @aeternum/blockchain build && \
    pnpm --filter @aeternum/db build && \
    pnpm --filter @aeternum/keeper build

# =============================================================================
# Production stage — only compiled output, no source or dev dependencies
# =============================================================================

FROM node:22-alpine AS runner

RUN npm install -g pnpm

WORKDIR /app
ENV NODE_ENV=production

# ── Copy only what is needed to run ──────────────────────────────────────────
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/node_modules ./node_modules

# Shared packages — dist only
COPY --from=builder /app/packages/config/dist ./packages/config/dist
COPY --from=builder /app/packages/config/package.json ./packages/config/package.json
COPY --from=builder /app/packages/blockchain/dist ./packages/blockchain/dist
COPY --from=builder /app/packages/blockchain/package.json ./packages/blockchain/package.json
COPY --from=builder /app/packages/db/dist ./packages/db/dist
COPY --from=builder /app/packages/db/package.json ./packages/db/package.json

# Keeper — dist + its own node_modules (viem, zod, etc.)
COPY --from=builder /app/apps/keeper/dist ./apps/keeper/dist
COPY --from=builder /app/apps/keeper/package.json ./apps/keeper/package.json
COPY --from=builder /app/apps/keeper/node_modules ./apps/keeper/node_modules

EXPOSE 3001

CMD ["node", "apps/keeper/dist/index.js"]