# Aeternum Indexer

On-chain event indexer for the AeternumVault smart contract. Built with Ponder, it indexes vault lifecycle events, stores normalized state in a PostgreSQL database, and exposes GraphQL and REST query endpoints.

## Features

- Indexes AeternumVault contract events on Sepolia
- Stores vault state, unified transaction history, and per-event balance ledger
- Exposes an auto-generated GraphQL API
- Provides custom REST endpoints
- Environment-driven configuration for RPC and contract addresses

## Requirements

- **Node.js 22** — Use Node.js 22 for the most stable and reliable indexing experience with Ponder 0.16.6. Ensure the workspace root .nvmrc file is updated to match.

## Schema

Three tables, defined in `ponder.schema.ts`:

- **`vaults`** — Core vault entity: registration data (`backupAddress`, `inactivityPeriod`), activity timestamp, and lifecycle flags (`isRecovered`, `isAbandoned`, `isCancelled`).
- **`vault_transactions`** — A unified ledger covering every wallet-level event: registrations, pings, backup/period updates, deposits, sends, withdrawals, and the full recovery lifecycle (`RECOVERY_EXECUTED`, `RECOVERY_FAILED`, `RECOVERY_ABANDONED`, `RECOVERY_CANCELLED`). There is no separate recovery-events table — all of it lives here, distinguished by the `type` column.
- **`balance_events`** — A secondary ledger scoped to balance-affecting events only (deposits, sends, withdrawals, and recovery outcomes), used to drive balance-over-time charting on the frontend.

## Setup

1. Install dependencies (from the monorepo root):

```bash
pnpm install
```

2. Configure environment variables. Shared variables (`CHAIN_ID`, `RPC_URL`, `CONTRACT_ADDRESS`, `CONTRACT_DEPLOY_BLOCK`, `DATABASE_URL`) come from the root `.env`. If the indexer ever needs its own app-specific variables, add them to `apps/indexer/.env`:

```bash
CHAIN_ID=11155111
RPC_URL=YourSepoliaRpcUrl
CONTRACT_ADDRESS=0xYourContractAddressHere
CONTRACT_DEPLOY_BLOCK=BlockNumber
DATABASE_URL=YourDatabaseUrl
```

## Scripts

```bash
cd apps/indexer
pnpm dev          # Start indexer in dev mode
pnpm build        # Build indexer package
pnpm start        # Start indexer in production mode
pnpm codegen      # Generate schema/type artifacts
```

## Configuration

- **Chain**: Sepolia (ID: 11155111)
- **RPC**: Configured via `RPC_URL`
- **Rate limit**: 10 requests/second
- **Block range**: 1000 blocks per log fetch
- **Contract**: AeternumVault address and ABI — the address comes from `CONTRACT_ADDRESS`, and the ABI is imported from `@aeternum/blockchain`, not stored locally in this app
- **Start block**: Read from `CONTRACT_DEPLOY_BLOCK`, currently block `11140604`

## API

The GraphQL API is exposed at:
- `/`
- `/graphql`

Custom REST endpoints are available via Hono (e.g. `/vault-count`).

## Deployment

Deployed as its own Railway service with `rootDirectory = "apps/indexer"` set in `railway.toml`, since this is one service among several in the monorepo.

## Notes

- Event handlers are in `src/index.ts`.
- API routes are in `src/api/`.
- Database schema is defined in `ponder.schema.ts`; Ponder owns migrations for this schema — `packages/db` mirrors it read-only for the keeper's use.
- Chain and contract configuration is in `ponder.config.ts`.