# @aeternum/campaign

Points, scoring, and redemption for the Aeternum incentivized testnet —
Sepolia phase (lower weight) through the mainnet phase (higher weight,
real deposits) to a single ETH redemption paid to each participant's
wallet at the end.

## What this is not

- Not a change to AeternumVault. Redemption is a plain ETH transfer to the
  wallet, not a vault deposit — no `fundVault()`, no new contract function,
  nothing added to what Hacken audits.
- Not the source of truth for Sepolia/mainnet vault state — that's Ponder,
  read via `@aeternum/db`. This service only owns its own tables (points,
  bug reports, referrals, social bonus, snapshots, redemptions), living in
  a separate `campaign` Postgres schema in the same database.

## Structure

- `src/db/` — campaign's own schema, client, and query helpers (migrated
  via `drizzle-kit`, independent of Ponder's migrations).
- `src/indexerReads/` — read-only queries against Ponder's tables, for
  scoring only. See the multi-chain caveat in that file before running
  mainnet scoring.
- `src/scoring/` — point values, the referral decay curve, anti-gaming
  checks, and the engine that turns on-chain activity into ledger entries.
- `src/integrations/galxe.ts` — pulls quest completions from Galxe.
- `src/api/` — the Hono app: leaderboard, points, referrals, bug reports,
  redemption.
- `src/redemption/` — pull-based claim flow. Proposes payouts to a
  treasury Safe rather than sending funds directly — see
  `redemption/treasury.ts`.
- `src/jobs/` — standalone scripts, meant to run as Render Cron Jobs:
  `nightlyScoring`, `monthlyLiveness`, `galxeSync`, and `snapshotFreeze`
  (the last one manual-only — see the file header).

## Test coverage

Unit tests (`test/unit/`) cover scoring, anti-gaming, the redemption
executor, and every API route, using `vi.mock` at each module boundary.
`test/integration/queries.test.ts` is different in kind — it runs the real
`db/queries.ts` functions against a real, in-process Postgres
(`@electric-sql/pglite`, WASM-compiled — not a mock), specifically to
verify the constraint-dependent behavior a mock can't: does a duplicate
ledger entry actually get rejected, does a snapshot upsert actually update
in place rather than duplicate, does the treasury sum actually aggregate
correctly. See `test/helpers/pglite.ts` for why it's structured as one
instance per file with truncation between tests rather than a fresh
instance per test (WASM cold start is ~4.5s; truncation is ~3ms).

## Known gaps, honestly

- **Funding-source clustering is not implemented** (`scoring/antiGaming.ts`).
  The indexer doesn't currently capture a wallet's first inbound transfer,
  which is what would reveal a shared funder across sybil wallets. Needs
  either a separate RPC-tracing process or a third-party service.
- **Safe integration is stubbed** (`redemption/treasury.ts`). No treasury
  Safe exists yet; `proposeSafeTransaction` logs what it would do instead
  of doing it.
- **Galxe's exact GraphQL field names are unverified** (`integrations/galxe.ts`).
  The endpoint, auth, pagination, and error handling are all tested against
  real (mocked) HTTP responses now — what's still unverified is only
  whether `QUEST_COMPLETIONS_QUERY`'s field names match Galxe's actual live
  schema, which needs a real Space and access token to confirm against
  their GraphQL Playground.

## Resolved since the initial build

- **Multi-chain indexing is now in place.** `vaults.id` in
  `ponder.schema.ts` has a `${chainId}-${wallet}` composite key, and every
  scoring function threads `chainId` through explicitly. `apps/keeper`'s
  scanner and the `packages/db` query helpers were updated to match.
- **This has been run for real** — `pnpm build` passes across the whole
  monorepo, migrations apply cleanly against a live Neon database, the API
  server boots, and the full test suite (unit + the pglite-backed
  integration suite) passes.

## Env vars marked TBD

`CAMPAIGN_MAINNET_WEIGHT_MULTIPLIER`, `CAMPAIGN_DEPOSIT_DUST_THRESHOLD_WEI`,
`CAMPAIGN_POINTS_TO_WEI_RATE`, and `CAMPAIGN_TREASURY_BUDGET_WEI` all ship
with safe-but-arbitrary defaults (mostly zero) rather than real values —
grep the codebase for "TBD" before this runs against real money.
