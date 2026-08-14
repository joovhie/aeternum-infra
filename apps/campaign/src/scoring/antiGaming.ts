/**
 * src/scoring/antiGaming.ts
 *
 * Anti-gaming checks applied before a ledger entry is awarded. This is the
 * piece flagged repeatedly through planning as load-bearing — especially
 * for uncapped referrals — so each check below is written to fail closed
 * (reject on doubt) rather than fail open.
 */

import type { DbClient } from "@aeternum/db";
import type { CampaignDbClient } from "../db/client.js";
import { pointsLedger } from "../db/schema.js";
import { and, eq, gte, sql } from "drizzle-orm";
import { hadEarlyWithdrawal } from "../indexerReads/queries.js";
import { campaignEnv } from "../env.js";
import { logger } from "../logger.js";

const MAX_ACTIONS_PER_WALLET_PER_DAY = 20;

/**
 * Rejects an action if the wallet has already earned more ledger entries
 * today than MAX_ACTIONS_PER_WALLET_PER_DAY. A blunt instrument — it caps
 * burst activity from a single address regardless of action type — but a
 * simple, hard-to-circumvent one.
 */
export async function underDailyRateLimit(
  db: CampaignDbClient,
  wallet: string,
): Promise<boolean> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pointsLedger)
    .where(and(eq(pointsLedger.wallet, wallet.toLowerCase()), gte(pointsLedger.createdAt, since)));

  const count = result[0]?.count ?? 0;
  if (count >= MAX_ACTIONS_PER_WALLET_PER_DAY) {
    logger.warn("Rate limit hit", { wallet, count });
    return false;
  }
  return true;
}

/**
 * Blocks a deposit-based award if the deposit was withdrawn or sent out
 * again within CAMPAIGN_MIN_HOLD_SECONDS — see indexerReads for the exact
 * heuristic.
 */
export async function clearedMinHold(
  indexerDb: DbClient,
  chainId: number,
  wallet: string,
  depositTimestamp: bigint,
): Promise<boolean> {
  const early = await hadEarlyWithdrawal(
    indexerDb,
    chainId,
    wallet,
    depositTimestamp,
    campaignEnv.CAMPAIGN_MIN_HOLD_SECONDS,
  );
  return !early;
}

/**
 * NOT IMPLEMENTED — funding-source clustering.
 *
 * The plan calls for flagging wallets funded from a common source as many
 * other participants (the classic sybil-farm tell). That check needs data
 * this codebase doesn't currently capture: the indexer only records events
 * emitted by AeternumVault itself, not each wallet's very first inbound ETH
 * transfer, which is what would reveal a shared funder.
 *
 * Building this for real means either (a) a separate process that queries
 * the RPC for each new participant wallet's earliest transaction, or
 * (b) a third-party clustering/sybil-detection service. Neither is stood
 * up yet. This function exists so the call site in computePoints.ts is
 * already wired up — it currently always returns true (no wallet flagged)
 * and logs a warning every time it's asked, so the gap stays visible in
 * production logs rather than silently doing nothing.
 */
export async function passesFundingSourceCheck(wallet: string): Promise<boolean> {
  logger.warn("passesFundingSourceCheck is a stub — funding-source clustering is not implemented", { wallet });
  return true;
}
