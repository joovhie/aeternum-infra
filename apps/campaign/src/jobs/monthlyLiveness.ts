/**
 * src/jobs/monthlyLiveness.ts
 *
 * Render Cron Job entrypoint — schedule for the 1st of each month.
 * Computes the checkpoint month from the current date rather than taking
 * it as an argument, so a scheduled run is always unambiguous about which
 * month it's crediting.
 *
 * Always runs against CHAIN_IDS.MAINNET — liveness is a mainnet-only
 * concept (see livenessCheckpoint.ts). Skips itself if mainnet indexing
 * isn't live yet, same gate as nightlyScoring.ts.
 */

import { env, CHAIN_IDS } from "@aeternum/config";
import { createDbClient } from "@aeternum/db";
import { createCampaignDbClient } from "../db/client.js";
import { runLivenessCheckpoint } from "../scoring/livenessCheckpoint.js";
import { campaignEnv } from "../env.js";
import { logger } from "../logger.js";

async function main() {
  if (!campaignEnv.MAINNET_INDEXING_LIVE) {
    logger.info("Monthly liveness checkpoint skipped — MAINNET_INDEXING_LIVE is false");
    process.exit(0);
  }

  const indexerDb = createDbClient(env.DATABASE_URL);
  const campaignDb = createCampaignDbClient(env.DATABASE_URL);

  const now = new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

  logger.info("Monthly liveness checkpoint starting", { month });
  const result = await runLivenessCheckpoint(indexerDb, campaignDb, CHAIN_IDS.MAINNET, month);
  logger.info("Monthly liveness checkpoint complete", { month, awarded: result.awarded });
  process.exit(0);
}

main().catch((err) => {
  logger.error("Monthly liveness checkpoint failed", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
