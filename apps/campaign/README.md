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

## Known gaps, honestly

- **Funding-source clustering is not implemented** (`scoring/antiGaming.ts`).
  The indexer doesn't currently capture a wallet's first inbound transfer,
  which is what would reveal a shared funder across sybil wallets. Needs
  either a separate RPC-tracing process or a third-party service.
- **Safe integration is stubbed** (`redemption/treasury.ts`). No treasury
  Safe exists yet; `proposeSafeTransaction` logs what it would do instead
  of doing it.
- **Galxe's exact GraphQL field names are unverified** (`integrations/galxe.ts`).
  The endpoint and auth are confirmed against Galxe's docs; the query
  shape is a reasonable placeholder — check it against the Playground
  schema before going live.
- **Multi-chain indexing isn't in place yet.** `vaults.id` in
  `ponder.schema.ts` has no chain discriminator — see the build plan's
  "Existing aeternum-infra files this touches" section. Don't point
  mainnet scoring at a database also indexing Sepolia until that's fixed.
- **This hasn't been run through `pnpm install` / `tsc` / `vitest`** in
  the environment it was written in — no live Postgres or workspace
  install was available. Run `pnpm install && pnpm --filter @aeternum/campaign build && pnpm --filter @aeternum/campaign test` after dropping this in, before trusting it.

## Env vars marked TBD

`CAMPAIGN_MAINNET_WEIGHT_MULTIPLIER`, `CAMPAIGN_DEPOSIT_DUST_THRESHOLD_WEI`,
`CAMPAIGN_POINTS_TO_WEI_RATE`, and `CAMPAIGN_TREASURY_BUDGET_WEI` all ship
with safe-but-arbitrary defaults (mostly zero) rather than real values —
grep the codebase for "TBD" before this runs against real money.
