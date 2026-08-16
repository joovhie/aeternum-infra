/**
 * src/jobs/nightlyScoring.ts
 *
 * Render Cron Job entrypoint. Runs both scoring passes over the last 25
 * hours (1-hour overlap with the previous run, to survive a missed or
 * delayed run without a gap — safe because insertLedgerEntries is
 * idempotent). Exits when done; not a long-running process.
 *
 * MULTI-CHAIN UPDATE: runs Sepolia scoring against CHAIN_IDS.SEPOLIA
 * unconditionally, and mainnet scoring against CHAIN_IDS.MAINNET only once
 * mainnet indexing is actually live — see the guard below. Running mainnet
 * scoring before the indexer tracks mainnet would just award nothing
 * every night, but the explicit guard makes that state visible in logs
 * instead of silently no-op'ing forever.
 */

import { env, CHAIN_IDS } from "@aeternum/config";
import { createDbClient } from "@aeternum/db";
import { createCampaignDbClient } from "../db/client.js";
import { runSepoliaScoring, runMainnetRegistrationScoring } from "../scoring/computePoints.js";
import { campaignEnv } from "../env.js";
import { logger } from "../logger.js";

const LOOKBACK_SECONDS = 25 * 60 * 60;

async function main() {
  const indexerDb = createDbClient(env.DATABASE_URL);
  const campaignDb = createCampaignDbClient(env.DATABASE_URL);
  const since = BigInt(Math.floor(Date.now() / 1000) - LOOKBACK_SECONDS);

  logger.info("Nightly scoring job starting", { since: since.toString() });

  const sepolia = await runSepoliaScoring(indexerDb, campaignDb, CHAIN_IDS.SEPOLIA, since);

  let mainnetAwarded = 0;
  if (campaignEnv.MAINNET_INDEXING_LIVE) {
    const mainnet = await runMainnetRegistrationScoring(indexerDb, campaignDb, CHAIN_IDS.MAINNET, since);
    mainnetAwarded = mainnet.awarded;
  } else {
    logger.info("Mainnet scoring skipped — MAINNET_INDEXING_LIVE is not set to 'true'");
  }

  logger.info("Nightly scoring job complete", { sepoliaAwarded: sepolia.awarded, mainnetAwarded });
  process.exit(0);
}

main().catch((err) => {
  logger.error("Nightly scoring job failed", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
