/**
 * src/jobs/monthlyLiveness.ts
 *
 * Render Cron Job entrypoint — schedule for the 1st of each month.
 * Computes the checkpoint month from the current date rather than taking
 * it as an argument, so a scheduled run is always unambiguous about which
 * month it's crediting.
 */

import { env } from "@aeternum/config";
import { createDbClient } from "@aeternum/db";
import { createCampaignDbClient } from "../db/client.js";
import { runLivenessCheckpoint } from "../scoring/livenessCheckpoint.js";
import { logger } from "../logger.js";

async function main() {
  const indexerDb = createDbClient(env.DATABASE_URL);
  const campaignDb = createCampaignDbClient(env.DATABASE_URL);

  const now = new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

  logger.info("Monthly liveness checkpoint starting", { month });
  const result = await runLivenessCheckpoint(indexerDb, campaignDb, month);
  logger.info("Monthly liveness checkpoint complete", { month, awarded: result.awarded });
  process.exit(0);
}

main().catch((err) => {
  logger.error("Monthly liveness checkpoint failed", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
