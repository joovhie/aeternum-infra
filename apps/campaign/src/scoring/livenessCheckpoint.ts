/**
 * src/scoring/livenessCheckpoint.ts
 *
 * Monthly mainnet liveness checkpoint. Deliberately does NOT score raw
 * ping() frequency — a wallet with a short inactivity timer would ping
 * often and a wallet with a sensible year-long timer might legitimately
 * never ping, so rewarding ping count would nudge people toward unsafe
 * short timers. Instead this checks that a vault is still registered,
 * still funded, and hasn't failed/been abandoned/been cancelled — the
 * state Ponder already tracks — regardless of how it got there.
 *
 * Called by src/jobs/monthlyLiveness.ts, once per calendar month.
 */

import type { DbClient } from "@aeternum/db";
import type { CampaignDbClient } from "../db/client.js";
import { insertLedgerEntries, type NewLedgerEntry } from "../db/queries.js";
import { getLiveVaults } from "../indexerReads/queries.js";
import { PHASE_WEIGHTS, MAINNET_ACTION_POINTS } from "./weights.js";
import { logger } from "../logger.js";

export async function runLivenessCheckpoint(
  indexerDb: DbClient,
  campaignDb: CampaignDbClient,
  checkpointMonth: string, // "YYYY-MM", passed in rather than computed here so a re-run is explicit about which month it's for
): Promise<{ awarded: number }> {
  const liveVaults = await getLiveVaults(indexerDb);

  const entries: NewLedgerEntry[] = liveVaults
    .filter((v) => v.inactivityPeriod > 0n) // must actually be configured, not a bare registration with no real timer
    .map((v) => ({
      wallet: v.id,
      phase: "mainnet" as const,
      actionType: "LIVENESS_CHECKPOINT",
      basePoints: MAINNET_ACTION_POINTS.LIVENESS_CHECKPOINT,
      weight: PHASE_WEIGHTS.mainnet,
      reference: `${v.id.toLowerCase()}-liveness-${checkpointMonth}`, // dedupe key: one credit per wallet per month
    }));

  const inserted = await insertLedgerEntries(campaignDb, entries);
  logger.info("Liveness checkpoint complete", { month: checkpointMonth, candidates: entries.length, awarded: inserted.length });
  return { awarded: inserted.length };
}
