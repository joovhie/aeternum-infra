/**
 * src/jobs/nightlyScoring.ts
 *
 * Render Cron Job entrypoint. Runs both scoring passes over the last 25
 * hours (1-hour overlap with the previous run, to survive a missed or
 * delayed run without a gap — safe because insertLedgerEntries is
 * idempotent). Exits when done; not a long-running process.
 */

import { env } from "@aeternum/config";
import { createDbClient } from "@aeternum/db";
import { createCampaignDbClient } from "../db/client.js";
import { runSepoliaScoring, runMainnetRegistrationScoring } from "../scoring/computePoints.js";
import { logger } from "../logger.js";

const LOOKBACK_SECONDS = 25 * 60 * 60;

async function main() {
  const indexerDb = createDbClient(env.DATABASE_URL);
  const campaignDb = createCampaignDbClient(env.DATABASE_URL);
  const since = BigInt(Math.floor(Date.now() / 1000) - LOOKBACK_SECONDS);

  logger.info("Nightly scoring job starting", { since: since.toString() });

  const sepolia = await runSepoliaScoring(indexerDb, campaignDb, since);
  const mainnet = await runMainnetRegistrationScoring(indexerDb, campaignDb, since);

  logger.info("Nightly scoring job complete", { sepoliaAwarded: sepolia.awarded, mainnetAwarded: mainnet.awarded });
  process.exit(0);
}

main().catch((err) => {
  logger.error("Nightly scoring job failed", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
