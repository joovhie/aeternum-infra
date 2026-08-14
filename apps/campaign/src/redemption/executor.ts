/**
 * src/redemption/executor.ts
 *
 * Pull-based redemption: a wallet requests a claim, this validates it
 * against the frozen snapshot and the treasury budget, and — if valid —
 * proposes the payout to the treasury Safe for signer review rather than
 * sending it directly. See treasury.ts for why.
 */

import type { CampaignDbClient } from "../db/client.js";
import {
  getSnapshotForWallet,
  getRedemptionByWallet,
  createRedemptionRequest,
  markRedemptionApproved,
  getCommittedTreasuryWei,
} from "../db/queries.js";
import { proposeSafeTransaction } from "./treasury.js";
import { campaignEnv } from "../env.js";
import { logger } from "../logger.js";

export type RedemptionResult =
  | { ok: true; status: "requested" | "already_requested"; ethAmountWei: string }
  | { ok: false; reason: string };

/**
 * Requests redemption for a wallet. Idempotent — calling this again for a
 * wallet that already has a request just returns its current state rather
 * than erroring.
 *
 * Budget handling: if the wallet's computed amount would push total
 * committed spend over CAMPAIGN_TREASURY_BUDGET_WEI, the amount is scaled
 * down pro-rata against remaining budget rather than rejected outright —
 * matches the plan's "pro-rata scaling if oversubscribed" rather than a
 * hard cutoff that arbitrarily favors whoever claims first.
 */
export async function requestRedemption(db: CampaignDbClient, wallet: `0x${string}`): Promise<RedemptionResult> {
  const existing = await getRedemptionByWallet(db, wallet);
  if (existing) {
    return { ok: true, status: "already_requested", ethAmountWei: existing.ethAmountWei };
  }

  const snapshot = await getSnapshotForWallet(db, wallet);
  if (!snapshot) {
    return { ok: false, reason: "no frozen snapshot found for this wallet — phase may not be closed yet" };
  }

  if (campaignEnv.CAMPAIGN_POINTS_TO_WEI_RATE === 0n) {
    return { ok: false, reason: "conversion rate not yet set — redemption is not open" };
  }

  const rawAmountWei = BigInt(snapshot.totalPoints) * campaignEnv.CAMPAIGN_POINTS_TO_WEI_RATE;

  const committed = await getCommittedTreasuryWei(db);
  const remaining = campaignEnv.CAMPAIGN_TREASURY_BUDGET_WEI - committed;

  if (remaining <= 0n) {
    return { ok: false, reason: "treasury budget exhausted" };
  }

  const amountWei = rawAmountWei > remaining ? remaining : rawAmountWei;

  const row = await createRedemptionRequest(db, {
    wallet,
    pointsRedeemed: snapshot.totalPoints,
    ethAmountWei: amountWei.toString(),
  });

  if (!row) {
    return { ok: false, reason: "redemption request already exists (race)" };
  }

  logger.info("Redemption requested", { wallet, points: snapshot.totalPoints, amountWei: amountWei.toString() });
  return { ok: true, status: "requested", ethAmountWei: amountWei.toString() };
}

/**
 * Admin-triggered: moves a pending request to approved and proposes the
 * Safe transaction. Does not itself execute or co-sign anything — that's
 * the Safe signers' job once the proposal shows up in their queue.
 */
export async function approveAndProposePayout(db: CampaignDbClient, wallet: `0x${string}`): Promise<void> {
  const row = await getRedemptionByWallet(db, wallet);
  if (!row || row.status !== "pending") {
    throw new Error(`No pending redemption for ${wallet}`);
  }

  await markRedemptionApproved(db, wallet);
  await proposeSafeTransaction({ wallet, amountWei: BigInt(row.ethAmountWei), redemptionId: row.id });
}
