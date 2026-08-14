/**
 * src/jobs/galxeSync.ts
 *
 * Render Cron Job entrypoint. Pulls quest completions from Galxe and
 * upserts them as social_bonus rows, then folds them into the points
 * ledger. Safe to re-run — both upsertSocialBonus and insertLedgerEntries
 * are dedupe-safe.
 */

import { env } from "@aeternum/config";
import { createCampaignDbClient } from "../db/client.js";
import { fetchQuestCompletions } from "../integrations/galxe.js";
import { upsertSocialBonus, insertLedgerEntries } from "../db/queries.js";
import { PHASE_WEIGHTS } from "../scoring/weights.js";
import { logger } from "../logger.js";

async function main() {
  const campaignDb = createCampaignDbClient(env.DATABASE_URL);

  logger.info("Galxe sync starting");
  const completions = await fetchQuestCompletions();

  for (const completion of completions) {
    await upsertSocialBonus(campaignDb, {
      wallet: completion.wallet,
      galxeQuestId: completion.questId,
      points: completion.points,
    });
  }

  const entries = completions.map((c) => ({
    wallet: c.wallet,
    phase: "sepolia" as const, // social tasks are scoped to the Sepolia phase — see campaign plan
    actionType: "SOCIAL_BONUS",
    basePoints: c.points,
    weight: PHASE_WEIGHTS.sepolia,
    reference: `galxe-${c.questId}-${c.wallet.toLowerCase()}`,
  }));

  const inserted = await insertLedgerEntries(campaignDb, entries);
  logger.info("Galxe sync complete", { pulled: completions.length, awarded: inserted.length });
  process.exit(0);
}

main().catch((err) => {
  logger.error("Galxe sync failed", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
