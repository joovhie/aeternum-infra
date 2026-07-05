# Dockerfile
# Build context: monorepo root

FROM node:22-alpine AS builder

RUN npm install -g pnpm

WORKDIR /app

# Copy the entire workspace layout to ensure a reliable build environment
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json ./
COPY packages/ ./packages/
COPY apps/ ./apps/

# 1. Install all dependencies (including devDependencies like TypeScript/Turbo)
RUN pnpm install --frozen-lockfile

# 2. Compile all internal packages and the keeper app
RUN pnpm --filter @aeternum/config build && \
    pnpm --filter @aeternum/blockchain build && \
    pnpm --filter @aeternum/db build && \
    pnpm --filter @aeternum/keeper build

# 3. Clean up: Strip out devDependencies to keep the final image lightweight
RUN pnpm prune --prod

# --- Production Stage ---
FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

# Copy the entire cloned and pruned workspace.
# Because the directory structure is an exact mirror of the builder stage,
# all internal symlinks and compiled 'dist' files remain completely intact.
COPY --from=builder /app ./

EXPOSE 3001

# Execute using the standard monorepo path
CMD ["node", "apps/keeper/dist/index.js"]