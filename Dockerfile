# =============================================================================
# Dockerfile
# Build context: monorepo root
# =============================================================================

FROM node:22-alpine AS builder

RUN npm install -g pnpm

WORKDIR /app

# --- Copy workspace manifests for layer caching ---
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

# --- Build shared packages then the keeper ---
RUN pnpm --filter @aeternum/config build && \
    pnpm --filter @aeternum/blockchain build && \
    pnpm --filter @aeternum/db build && \
    pnpm --filter @aeternum/keeper build

# --- Isolate the keeper application ---
# This command strips away the monorepo structure and outputs a fully flat,
# production-ready standalone directory with un-broken dependencies.
RUN pnpm --filter=@aeternum/keeper --prod deploy --legacy /app/isolated

# =============================================================================
# Production stage — Completely self-contained, no broken symlinks
# =============================================================================

FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

# Copy the entirely flattened, self-contained isolated directory
COPY --from=builder /app/isolated ./

EXPOSE 3001

# CRITICAL: Because pnpm deploy flattens the directory, the keeper's 
# built files are now at the root of the copy target.
CMD ["node", "dist/index.js"]