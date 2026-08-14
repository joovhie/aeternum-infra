/**
 * src/scoring/computePoints.ts
 *
 * The scoring engine. Reads on-chain activity from the indexer (via
 * @aeternum/db), runs it through the anti-gaming checks, and writes
 * awarded points to campaign's own ledger. Designed to be re-run safely —
 * every write goes through insertLedgerEntries' onConflictDoNothing, so
 * running this twice over the same window awards nothing twice.
 *
 * Called by src/jobs/nightlyScoring.ts. Not a long-running process itself.
 */

import { MAX_RECOVERY_ATTEMPTS } from "@aeternum/config";
import type { DbClient } from "@aeternum/db";
import type { CampaignDbClient } from "../db/client.js";
import { insertLedgerEntries, type NewLedgerEntry } from "../db/queries.js";
import { getTransactionsByType } from "../indexerReads/queries.js";
import { underDailyRateLimit, clearedMinHold, passesFundingSourceCheck } from "./antiGaming.js";
import { PHASE_WEIGHTS, SEPOLIA_ACTION_POINTS, MAINNET_ACTION_POINTS, depositSizeMultiplier } from "./weights.js";
import { campaignEnv } from "../env.js";
import { logger } from "../logger.js";

/**
 * Sepolia-phase scoring. Awards:
 *  - REGISTERED          — flat points per registration event
 *  - CORE_RECOVERY_CYCLE — a completed RecoveryExecuted (the full
 *                           register → deposit → wait → recover loop)
 *  - EDGE_CASE_REPRODUCTION — the three-attempt failure cycle (the 3rd
 *                           RECOVERY_FAILED for a wallet), and a
 *                           RecoveryCancelled with a zero refund amount
 *                           (cancel-on-zero-balance)
 *
 * "Re-registration after abandonment" and other multi-event edge cases
 * from the testnet doc are intentionally not scored here yet — they need
 * a wider event-correlation window than a single incremental pass gives
 * cleanly. Flagged rather than faked.
 */
export async function runSepoliaScoring(
  indexerDb: DbClient,
  campaignDb: CampaignDbClient,
  sinceUnixSeconds: bigint,
): Promise<{ awarded: number }> {
  const entries: NewLedgerEntry[] = [];

  const registered = await getTransactionsByType(indexerDb, "REGISTERED", sinceUnixSeconds);
  for (const tx of registered) {
    entries.push({
      wallet: tx.wallet,
      phase: "sepolia",
      actionType: "REGISTERED",
      basePoints: SEPOLIA_ACTION_POINTS.REGISTERED,
      weight: PHASE_WEIGHTS.sepolia,
      reference: tx.id,
    });
  }

  const recovered = await getTransactionsByType(indexerDb, "RECOVERY_EXECUTED", sinceUnixSeconds);
  for (const tx of recovered) {
    entries.push({
      wallet: tx.wallet,
      phase: "sepolia",
      actionType: "CORE_RECOVERY_CYCLE",
      basePoints: SEPOLIA_ACTION_POINTS.CORE_RECOVERY_CYCLE,
      weight: PHASE_WEIGHTS.sepolia,
      reference: tx.id,
    });
  }

  const cancelled = await getTransactionsByType(indexerDb, "RECOVERY_CANCELLED", sinceUnixSeconds);
  for (const tx of cancelled) {
    if (tx.amount !== null && tx.amount !== 0n) continue; // only the zero-balance edge case counts here
    entries.push({
      wallet: tx.wallet,
      phase: "sepolia",
      actionType: "EDGE_CASE_REPRODUCTION",
      basePoints: SEPOLIA_ACTION_POINTS.EDGE_CASE_REPRODUCTION,
      weight: PHASE_WEIGHTS.sepolia,
      reference: tx.id,
    });
  }

  // Three-attempt failure cycle: award once, on the Nth failure per wallet,
  // where N = MAX_RECOVERY_ATTEMPTS (mirrors the contract's own retry cap
  // rather than hardcoding 3 here).
  const failed = await getTransactionsByType(indexerDb, "RECOVERY_FAILED", sinceUnixSeconds);
  const failuresByWallet = new Map<string, number>();
  for (const tx of failed) {
    const key = tx.wallet.toLowerCase();
    const count = (failuresByWallet.get(key) ?? 0) + 1;
    failuresByWallet.set(key, count);
    if (count === MAX_RECOVERY_ATTEMPTS) {
      entries.push({
        wallet: tx.wallet,
        phase: "sepolia",
        actionType: "EDGE_CASE_REPRODUCTION",
        basePoints: SEPOLIA_ACTION_POINTS.EDGE_CASE_REPRODUCTION,
        weight: PHASE_WEIGHTS.sepolia,
        reference: `${tx.wallet.toLowerCase()}-three-attempt-cycle`,
      });
    }
  }

  const filtered: NewLedgerEntry[] = [];
  for (const entry of entries) {
    if (!(await underDailyRateLimit(campaignDb, entry.wallet))) continue;
    if (!(await passesFundingSourceCheck(entry.wallet))) continue;
    filtered.push(entry);
  }

  const inserted = await insertLedgerEntries(campaignDb, filtered);
  logger.info("Sepolia scoring pass complete", { candidates: entries.length, awarded: inserted.length });
  return { awarded: inserted.length };
}

/**
 * Mainnet-phase registration + deposit scoring. Awards points on a
 * wallet's first qualifying DEPOSIT since sinceUnixSeconds, gated by the
 * dust threshold (deposits at or below it earn nothing) and the min-hold
 * check (a deposit withdrawn again quickly earns nothing).
 *
 * NOTE: see indexerReads/queries.ts's multi-chain caveat — this reads the
 * same vault_transactions table Sepolia scoring does. Until apps/indexer
 * distinguishes chains, this function should not be run against a database
 * that's also indexing Sepolia, or Sepolia deposits get mainnet weight.
 */
export async function runMainnetRegistrationScoring(
  indexerDb: DbClient,
  campaignDb: CampaignDbClient,
  sinceUnixSeconds: bigint,
): Promise<{ awarded: number }> {
  const deposits = await getTransactionsByType(indexerDb, "DEPOSIT", sinceUnixSeconds);
  const entries: NewLedgerEntry[] = [];

  for (const tx of deposits) {
    const amount = tx.amount ?? 0n;
    if (amount < campaignEnv.CAMPAIGN_DEPOSIT_DUST_THRESHOLD_WEI) continue;

    if (!(await clearedMinHold(indexerDb, tx.wallet, tx.timestamp))) continue;
    if (!(await underDailyRateLimit(campaignDb, tx.wallet))) continue;
    if (!(await passesFundingSourceCheck(tx.wallet))) continue;

    const multiplier = depositSizeMultiplier(amount);
    entries.push({
      wallet: tx.wallet,
      phase: "mainnet",
      actionType: "REGISTER_DEPOSIT",
      basePoints: Math.round(MAINNET_ACTION_POINTS.REGISTER_DEPOSIT_BASE * multiplier),
      weight: PHASE_WEIGHTS.mainnet,
      reference: tx.id,
    });
  }

  const inserted = await insertLedgerEntries(campaignDb, entries);
  logger.info("Mainnet registration scoring pass complete", { candidates: entries.length, awarded: inserted.length });
  return { awarded: inserted.length };
}
