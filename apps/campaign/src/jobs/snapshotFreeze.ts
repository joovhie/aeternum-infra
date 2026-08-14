/**
 * src/jobs/snapshotFreeze.ts
 *
 * NOT scheduled — run this by hand, once, at the close of the mainnet
 * phase. Freezing the ledger is a real decision with real ETH riding on
 * it downstream, so it deliberately isn't automated the way the nightly
 * and monthly jobs are.
 *
 * Safe to re-run before redemption opens (writeSnapshot upserts), but
 * once CAMPAIGN_POINTS_TO_WEI_RATE is set and redemption requests start
 * coming in, re-running this and changing anyone's frozen total would be
 * changing the terms after the fact. Don't.
 */

import { env } from "@aeternum/config";
import { createCampaignDbClient } from "../db/client.js";
import { getAllWalletTotals, writeSnapshot } from "../db/queries.js";
import { logger } from "../logger.js";

async function main() {
  const campaignDb = createCampaignDbClient(env.DATABASE_URL);

  const totals = await getAllWalletTotals(campaignDb);
  logger.info("Freezing snapshot", { walletCount: totals.length });

  for (const { wallet, total } of totals) {
    await writeSnapshot(campaignDb, wallet, total);
  }

  logger.info("Snapshot freeze complete", { walletCount: totals.length });
  process.exit(0);
}

main().catch((err) => {
  logger.error("Snapshot freeze failed", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
