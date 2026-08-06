# Aeternum Infrastructure

[![Lint](https://github.com/Aeternumlabs/aeternum-infra/actions/workflows/lint.yml/badge.svg)](https://github.com/Aeternumlabs/aeternum-infra/actions/workflows/lint.yml)
[![Tests](https://github.com/Aeternumlabs/aeternum-infra/actions/workflows/test.yml/badge.svg)](https://github.com/Aeternumlabs/aeternum-infra/actions/workflows/test.yml)

This repo houses the off-chain infrastructure supporting the Aeternum protocol, including indexing, automation, monitoring, and backend services.

## Apps

- **indexer** — On-chain event indexer for AeternumVault with GraphQL + REST API
- **keeper** — Automated recovery bot that scans for due vaults and executes recoveries
- **notifications** — (coming soon) Notification service for protocol events

## Packages

- **blockchain** — Contract ABIs, viem client factories, and network addresses
- **db** — PostgreSQL client and shared query helpers
- **config** — Environment validation with Zod and shared constants

## Requirements

- **Node.js 22** — Use Node.js 22 for the most stable and reliable indexing experience with Ponder 0.16.6 (used by `apps/indexer`).
- **pnpm >= 9**

## Folder structure

```
aeternum-infra/
│
├── apps/
│   │
│   ├── indexer/                          ← Ponder-based event indexer
│   │   ├── .env.example                  ← indexer-specific env vars
│   │   ├── package.json
│   │   ├── ponder.config.ts              ← chain + contract configuration
│   │   ├── ponder.schema.ts              ← database schema definitions
│   │   ├── railway.toml                  ← indexer-specific Railway config
│   │   ├── README.md                     ← indexer documentation
│   │   ├── src/                          ← source code
│   │   └── tsconfig.json                 ← extends ../../tsconfig.json
│   │
│   ├── keeper/                           ← Automated recovery bot
│   │   ├── .env.example                  ← keeper-specific env vars
│   │   ├── package.json
│   │   ├── railway.toml                  ← keeper-specific Railway config
│   │   ├── README.md                     ← keeper documentation
│   │   ├── src/                          ← source code
│   │   ├── test/                         ← unit + integration tests
│   │   ├── vitest.config.ts              ← test configuration
│   │   └── tsconfig.json                 ← extends ../../tsconfig.json
│   │
│   └── notifications/                    ← stub — not yet implemented
│
├── packages/
│   │
│   ├── blockchain/                       ← ABI, viem clients, contract addresses
│   │   ├── src/
│   │   │   ├── index.ts                  ← barrel export
│   │   │   ├── abi.ts                    ← AeternumVault and Multicall3 ABIs
│   │   │   ├── addresses.ts              ← contract address per network
│   │   │   └── client.ts                 ← viem publicClient + walletClient factory
│   │   ├── package.json
│   │   └── tsconfig.json                 ← extends ../../tsconfig.json
│   │
│   ├── db/                               ← database client + shared query helpers
│   │   ├── src/
│   │   │   ├── index.ts                  ← barrel export
│   │   │   ├── client.ts                 ← postgres client instance
│   │   │   └── queries.ts                ← shared query helpers (due vaults, etc.)
│   │   ├── package.json
│   │   └── tsconfig.json                 ← extends ../../tsconfig.json
│   │
│   └── config/                           ← env validation + shared constants
│       ├── src/
│       │   ├── index.ts                  ← barrel export
│       │   ├── env.ts                    ← zod env schema, validated at startup
│       │   └── constants.ts              ← chain IDs, timing constants, network names
│       ├── package.json
│       └── tsconfig.json                 ← extends ../../tsconfig.json
│
├── .env.example                          ← root-level shared env vars
├── .gitignore
├── package.json                          ← workspace root, no source
├── pnpm-lock.yaml
├── pnpm-workspace.yaml                   ← declares apps/* and packages/*
├── README.md
├── tsconfig.json                         ← base config extended by all apps/packages
└── turbo.json                            ← build pipeline + task dependency graph
```

## Setup

```bash
pnpm install
cp .env.example .env
```

Fill in the shared values in `.env` (RPC URL, contract address, database URL — see `.env.example` for the full list). Each app may also have its own `.env.example` for app-specific variables (e.g. the keeper's signing key) — copy those to `.env` inside the relevant `apps/<app>/` directory.

## Environment variable inheritance

Shared variables live in the root `.env`. App-specific variables live in each app's own `apps/<app>/.env`. Locally, each app's `dev`/`start` scripts load both files via `dotenv-cli`, with the app-level file taking precedence on any overlapping key:

```bash
dotenv -e ../../.env.local -e .env.local -- <command>
```

On Render, the equivalent is a **Shared Variable Group** referenced by each service, with app-specific variables set directly on that service. See each app's own README for its specific variables.

## Commands

```bash
pnpm dev          # Start all apps in dev mode
pnpm build        # Build all packages
pnpm lint         # Lint all packages
pnpm test         # Run all tests
pnpm format       # Format code with Prettier
```

## Notes

- Uses pnpm workspaces for monorepo management.
- Turbo handles the build pipeline and task orchestration (`turbo.json`).
- TypeScript is pinned to `^6.0.3` across the workspace for consistency; the root `tsconfig.json` is extended by every app and package.
- See individual app READMEs for detailed setup and configuration.