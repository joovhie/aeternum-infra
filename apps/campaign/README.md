# Aeternum Campaign

Points, scoring, referrals, bug reports, and redemption for the Aeternum incentivized testnet. Participants earn points across Sepolia and mainnet, redeemable for ETH transferred to their wallet at campaign end.

## Features

- Multi-phase campaign scoring with phase-specific point weights
- Referral system with decay curve for viral growth incentives
- Bug report submission and curation workflow
- Galxe quest completion integration
- Anti-gaming checks (activity clustering, sybil detection infrastructure)
- Snapshot-based redemption flow with treasury Safe support
- Cron jobs for nightly scoring, monthly liveness checks, and Galxe sync
- Unit and integration test suite with real in-process Postgres validation

## Architecture

- **src/db/** — Campaign's own schema and query helpers (Drizzle ORM, independent migrations)
- **src/scoring/** — Point calculation engine, referral decay, anti-gaming checks
- **src/api/** — REST API (Hono): leaderboard, points, referrals, bug reports, redemption endpoints
- **src/redemption/** — Pull-based claim flow, treasury Safe integration
- **src/indexerReads/** — Read-only queries against Ponder's vault tables for scoring
- **src/integrations/galxe.ts** — Galxe quest completion polling
- **src/jobs/** — Standalone cron scripts: nightlyScoring, monthlyLiveness, galxeSync, snapshotFreeze
- **src/logger.ts** — Structured JSON logging

## Setup

1. Install dependencies (from the monorepo root):

```bash
pnpm install
```

2. Configure environment variables. Shared variables (`CHAIN_ID`, `RPC_URL`, `CONTRACT_ADDRESS`, `DATABASE_URL`) come from the root `.env`. Campaign-specific variables go in `apps/campaign/.env`:

```bash
# Optional — see Configuration below; defaults to 1
CAMPAIGN_MAINNET_WEIGHT_MULTIPLIER=3

# Optional — wei threshold for dust filtering (default: 0)
CAMPAIGN_DEPOSIT_DUST_THRESHOLD_WEI=1000000000000000000

# Optional — points-to-ETH conversion rate (default: 0)
CAMPAIGN_POINTS_TO_WEI_RATE=1000000000000000

# Optional — total ETH budget for redemptions (default: 0)
CAMPAIGN_TREASURY_BUDGET_WEI=1000000000000000000

# Galxe integration (if running galxeSync job)
GALXE_API_KEY=YourGalxeApiKeyHere
```

## Scripts

```bash
cd apps/campaign
pnpm dev               # Start API server in development mode
pnpm build             # Build TypeScript to dist/
pnpm lint              # Type check with TypeScript
pnpm test              # Run all tests
pnpm test:unit         # Run unit tests only
pnpm test:integration  # Run integration tests only
pnpm test:watch        # Run tests in watch mode
pnpm test:coverage     # Run tests with a coverage report
```

## Configuration

- **Campaign phases** — Configured via `CAMPAIGN_MAINNET_WEIGHT_MULTIPLIER`. Sepolia phase uses weight = 1; mainnet phase multiplies by this value. Default is 1 (equivalent weights).
- **Dust filtering** — Points from deposits below `CAMPAIGN_DEPOSIT_DUST_THRESHOLD_WEI` are filtered during scoring. Default is 0 (no filtering).
- **Point-to-ETH rate** — `CAMPAIGN_POINTS_TO_WEI_RATE` defines the redemption conversion. Unset or 0 disables redemptions. **Grep for "TBD" before running against real money.**
- **Treasury budget** — `CAMPAIGN_TREASURY_BUDGET_WEI` caps total payout. Default is 0.

## How It Works

1. **Scoring cycle** (nightly):
   - Queries Ponder's vault tables for deposits, withdrawals, and activity
   - Applies phase-appropriate weight multiplier
   - Runs anti-gaming checks and filters dust
   - Writes ledger entries (points awarded per wallet)
   - Updates leaderboard snapshot

2. **Referrals**:
   - Referrer earns bonus for each unique referee's deposits
   - Bonus decays with successive referrals to incentivize breadth over sybils

3. **Redemption** (pull-based):
   - Participant requests payout
   - System proposes transaction to treasury Safe
   - Fund transfer occurs via plain ETH transfer, not vault deposit

4. **Cron jobs**:
   - **nightlyScoring** — Runs the scoring cycle
   - **monthlyLiveness** — Validates active participants
   - **galxeSync** — Polls Galxe API for quest completions
   - **snapshotFreeze** — Manual snapshot export (see file header)

## Testing

- **Unit tests** (`test/unit/`) — Scoring logic, anti-gaming checks, API routes with mocked dependencies
- **Integration tests** (`test/integration/`) — Real in-process Postgres (`@electric-sql/pglite`) validation. Verifies constraint behavior, upserts, aggregations, and ledger uniqueness that mocks cannot.
  - `queries.test.ts` runs a single shared PGlite instance with truncation between tests (cold start ~4.5s, truncation ~3ms)

## Known Gaps

- **Funding-source clustering** — Not implemented. Requires RPC tracing to detect shared funders across sybil wallets.
- **Safe integration** — Stubbed. `proposeSafeTransaction` logs instead of executing.
- **Galxe field verification** — Schema field names are untested against live Galxe GraphQL endpoint; requires real Space and access token.

## Notes

- Drizzle ORM manages campaign schema independently from Ponder's migrations
- Multi-chain support: `chainId` is threaded through scoring and stored in ledger entries
- Uses Zod for environment variable validation
- Structured JSON logs for observability
