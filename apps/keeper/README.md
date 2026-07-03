# Aeternum Keeper

Automated recovery bot for the Aeternum protocol. Scans for vaults that are due for recovery and executes triggerRecovery transactions via Multicall3 to minimize gas costs.

## Features

- Periodic scanning for vaults due for recovery
- On-chain validation via multicall before execution
- Batch execution using Multicall3.aggregate3 with failure isolation
- Structured JSON logging for observability
- Health check endpoint for monitoring
- Comprehensive test suite with unit and integration tests

## Architecture

- **index.ts** — Main entry point, polling loop, health server, and graceful shutdown
- **scanner.ts** — DB pre-filtering and on-chain validation via multicall
- **executor.ts** — Batch transaction submission via Multicall3
- **logger.ts** — Structured JSON logging

## Setup

1. Install dependencies:

```bash
pnpm install
```

2. Configure environment variables in `.env.local`:

```bash
# Shared variables (inherited from root .env.local)
CHAIN_ID=11155111
RPC_URL=YourSepoliaRpcUrl
CONTRACT_ADDRESS=0xYourContractAddressHere
DATABASE_URL=YourDatabaseUrl

# Keeper-specific variables
KEEPER_PRIVATE_KEY=YourPrivateKeyHere
KEEPER_POLL_INTERVAL_MS=12000
KEEPER_BATCH_SIZE=600
```

## Scripts

```bash
cd apps/keeper
pnpm dev               # Start keeper in development mode
pnpm start             # Start keeper in production mode
pnpm build             # Build TypeScript to dist/
pnpm lint              # Type check with TypeScript
pnpm test              # Run all tests
pnpm test:unit         # Run unit tests only
pnpm test:integration  # Run integration tests only
pnpm test:watch        # Run tests in watch mode
pnpm test:coverage     # Run tests with coverage report
```

## Configuration

- **Poll interval**: `KEEPER_POLL_INTERVAL_MS` (default: 12000ms, synced to L1 12s heartbeat)
- **Batch size**: `KEEPER_BATCH_SIZE` (max vaults pulled from DB per scan, recommended: 600)
- **Batch execution**: 120 wallets per transaction via Multicall3 (MAX_CALLS_PER_TX)
- **Gas buffer**: 30% buffer on estimated gas to handle EIP-150 overhead

## How It Works

1. **Scan cycle**: Every `KEEPER_POLL_INTERVAL_MS`, the keeper:
   - Queries DB for vaults marked as due (up to `KEEPER_BATCH_SIZE`)
   - Validates on-chain via multicall to confirm still due
   - Filters out stale entries where vault is no longer due

2. **Execution**: For confirmed due vaults:
   - Splits into batches of 20 wallets
   - Submits via Multicall3.aggregate3 with `allowFailure: true`
   - Each wallet's recovery succeeds or fails independently
   - Logs RecoveryExecuted, RecoveryFailed, or RecoveryAbandoned events

3. **Failure handling**:
   - Failed batches don't abort subsequent batches
   - Failed recoveries increment attempt count and retry next cycle
   - Abandoned after MAX_RECOVERY_ATTEMPTS

## Testing

The keeper has comprehensive test coverage:

- **Unit tests**: Individual component testing (scanner, executor, logger, main loop)
- **Integration tests**: End-to-end workflows (due vault recovery, stale entries, failed retries, abandoned recoveries, batch execution)
- **Coverage**: 100% coverage across all source files

## Health Check

The keeper exposes a health check endpoint on port 3001 for monitoring services.

## Notes

- Uses viem for blockchain interactions
- Uses Zod for environment variable validation
- Graceful shutdown on SIGTERM/SIGINT
- Structured JSON logs for easy parsing
