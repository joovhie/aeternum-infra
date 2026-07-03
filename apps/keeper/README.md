# Aeternum Keeper

Automated recovery bot for the Aeternum protocol. Scans for vaults that are due for recovery and executes `triggerRecovery` transactions via Multicall3 to minimize gas costs and isolate per-wallet failures.

## Features

- Periodic scanning for vaults due for recovery (DB pre-filter + on-chain validation)
- Batch execution using Multicall3.aggregate3 with per-wallet failure isolation
- Per-batch gas estimation with a safety buffer and a hard gas ceiling
- Structured JSON logging for observability
- Health check endpoint for monitoring
- Unit and integration test suite

## Architecture

- **index.ts** — Main entry point, polling loop, health server, and graceful shutdown
- **scanner.ts** — DB pre-filtering and on-chain validation via multicall
- **executor.ts** — Batch transaction submission via Multicall3, including gas estimation and buffering
- **logger.ts** — Structured JSON logging

## Setup

1. Install dependencies (from the monorepo root):

```bash
pnpm install
```

2. Configure environment variables. Shared variables (`CHAIN_ID`, `RPC_URL`, `CONTRACT_ADDRESS`, `DATABASE_URL`) come from the root `.env`. Keeper-specific variables go in `apps/keeper/.env`:

```bash
# Keeper-specific variables
KEEPER_PRIVATE_KEY=YourPrivateKeyHere       # accepts either 0x-prefixed or bare hex
KEEPER_POLL_INTERVAL_MS=12000               # optional — see Configuration below
KEEPER_BATCH_SIZE=600                       # optional — see Configuration below
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
pnpm test:coverage     # Run tests with a coverage report
```

## Configuration

- **Poll interval** — `KEEPER_POLL_INTERVAL_MS` (default: 12000ms, synced to L1 12s heartbeat). This is the gap after a cycle completes before the next one starts. 
- **DB scan size** — `KEEPER_BATCH_SIZE` (default: 600). How many candidate vaults are pulled from the database per scan. This is intentionally decoupled from the per-transaction call limit below — a single scan can surface more wallets than fit in one transaction, in which case the executor splits them across multiple sequential transactions within the same cycle.
- **Calls per transaction** — hard-capped at `MAX_CALLS_PER_TX = 120` in `executor.ts`, independent of `KEEPER_BATCH_SIZE`. Raising the DB scan size never silently grows the size of a single transaction. Derived from measured gas cost: 120 × ~91k gas (worst-case `triggerRecovery`) × 1.3 buffer ≈ 14.2M gas, comfortably under the current 60M block gas limit.
- **Gas estimation** — before each batch is submitted, gas is estimated via `estimateContractGas` and inflated by 30% (empirical margin against EIP-150 gas-forwarding imprecision across nested calls), then clamped to a hard ceiling of 20,000,000 gas as defense in depth against an anomalous estimate.

## How It Works

1. **Scan cycle**: every `KEEPER_POLL_INTERVAL_MS` after the previous cycle completes, the keeper:
   - Queries the DB for vaults marked as due (up to `KEEPER_BATCH_SIZE`)
   - Validates on-chain via multicall to confirm each is still actually due
   - Filters out stale entries where the vault is no longer due (e.g. the owner pinged since the DB snapshot)

2. **Execution**: for confirmed due vaults:
   - Splits into batches of at most `MAX_CALLS_PER_TX` (120) wallets
   - Estimates gas per batch, applies the 30% buffer, and clamps to the safety ceiling
   - Submits via `Multicall3.aggregate3` with `allowFailure: true`
   - Each wallet's recovery succeeds or fails independently within the batch
   - Logs `RecoveryExecuted`, `RecoveryFailed`, or `RecoveryAbandoned` per wallet

3. **Failure handling**:
   - A failed batch (submission error, dropped tx, gas estimation failure) is logged and does not abort subsequent batches in the same cycle
   - Failed recoveries (e.g. a backup address that rejects ETH) increment the on-chain attempt count and are retried automatically on a future cycle, since the vault remains active
   - After the contract's `MAX_RECOVERY_ATTEMPTS` is reached, the vault is abandoned on-chain and no longer surfaces in future scans

## Testing

- **Unit tests**: individual component testing (scanner, executor, logger, main loop)
- **Integration tests**: end-to-end workflows (due vault recovery, stale DB entries, failed-recovery retries, abandoned recoveries, batch execution at scale)
- Run `pnpm test:coverage` for current coverage — the suite targets full coverage of every source file, including error branches for non-`Error` thrown values and the gas-buffer clamping logic

## Health Check

The keeper exposes a health check endpoint at `/health` on port 3001 by default, or on the `PORT` environment variable if set (Railway sets this automatically for web-exposed services).

## Notes

- Uses viem for blockchain interactions.
- Uses Zod for environment variable validation, including private key format normalization (accepts keys with or without a `0x` prefix).
- Graceful shutdown on SIGTERM (finishes the current cycle first) and SIGINT (exits immediately).
- Structured JSON logs for easy parsing.