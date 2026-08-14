/**
 * src/db/queries.ts
 *
 * Typed query helpers over campaign's own tables. Scoring logic
 * (src/scoring/*) computes what to award; these functions are the only
 * place that actually writes it.
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { CampaignDbClient } from "./client.js";
import {
  pointsLedger,
  bugReports,
  referralCodes,
  referralCredits,
  socialBonus,
  snapshots,
  redemptions,
  type PointsLedgerRow,
  type BugReportRow,
  type ReferralCreditRow,
  type SnapshotRow,
  type RedemptionRow,
} from "./schema.js";

// ─── Points ledger ──────────────────────────────────────────────────────────

export interface NewLedgerEntry {
  wallet: string;
  phase: "sepolia" | "mainnet";
  actionType: string;
  basePoints: number;
  weight: number;
  reference: string;
}

/**
 * Inserts a batch of ledger entries, skipping any that collide with an
 * existing (wallet, actionType, reference) row. Safe to call repeatedly
 * over the same source data — that's the whole point of the unique
 * constraint on points_ledger.
 *
 * Returns only the rows that were actually inserted (new points awarded).
 */
export async function insertLedgerEntries(
  db: CampaignDbClient,
  entries: NewLedgerEntry[],
): Promise<PointsLedgerRow[]> {
  if (entries.length === 0) return [];

  const rows = entries.map((e) => ({
    id: randomUUID(),
    wallet: e.wallet.toLowerCase(),
    phase: e.phase,
    actionType: e.actionType,
    basePoints: e.basePoints,
    weight: e.weight.toString(),
    weightedPoints: Math.round(e.basePoints * e.weight),
    reference: e.reference,
  }));

  return db
    .insert(pointsLedger)
    .values(rows)
    .onConflictDoNothing({ target: [pointsLedger.wallet, pointsLedger.actionType, pointsLedger.reference] })
    .returning();
}

export async function getPointsByWallet(
  db: CampaignDbClient,
  wallet: string,
): Promise<{ phase: string; total: number }[]> {
  return db
    .select({
      phase: pointsLedger.phase,
      total: sql<number>`sum(${pointsLedger.weightedPoints})::int`,
    })
    .from(pointsLedger)
    .where(eq(pointsLedger.wallet, wallet.toLowerCase()))
    .groupBy(pointsLedger.phase);
}

export async function getLedgerForWallet(
  db: CampaignDbClient,
  wallet: string,
): Promise<PointsLedgerRow[]> {
  return db
    .select()
    .from(pointsLedger)
    .where(eq(pointsLedger.wallet, wallet.toLowerCase()))
    .orderBy(desc(pointsLedger.createdAt));
}

/** Every wallet's all-time total, unpaginated — used only by the snapshot freeze job, which needs the complete set, not a top-N page. */
export async function getAllWalletTotals(db: CampaignDbClient): Promise<{ wallet: string; total: number }[]> {
  return db
    .select({
      wallet: pointsLedger.wallet,
      total: sql<number>`sum(${pointsLedger.weightedPoints})::int`,
    })
    .from(pointsLedger)
    .groupBy(pointsLedger.wallet);
}

export async function getLeaderboard(
  db: CampaignDbClient,
  limit = 100,
): Promise<{ wallet: string; total: number }[]> {
  return db
    .select({
      wallet: pointsLedger.wallet,
      total: sql<number>`sum(${pointsLedger.weightedPoints})::int`,
    })
    .from(pointsLedger)
    .groupBy(pointsLedger.wallet)
    .orderBy(desc(sql`sum(${pointsLedger.weightedPoints})`))
    .limit(limit);
}

// ─── Bug reports ────────────────────────────────────────────────────────────

export async function insertBugReport(
  db: CampaignDbClient,
  input: { wallet: string; category: string; title: string; description: string; severity: string },
): Promise<BugReportRow> {
  const [row] = await db
    .insert(bugReports)
    .values({ id: randomUUID(), ...input, wallet: input.wallet.toLowerCase() })
    .returning();
  return row;
}

export async function reviewBugReport(
  db: CampaignDbClient,
  id: string,
  input: { status: string; reviewedBy: string; pointsAwarded?: number },
): Promise<BugReportRow | undefined> {
  const [row] = await db
    .update(bugReports)
    .set({ ...input, reviewedAt: new Date() })
    .where(eq(bugReports.id, id))
    .returning();
  return row;
}

// ─── Referrals ──────────────────────────────────────────────────────────────

export async function getOrCreateReferralCode(
  db: CampaignDbClient,
  wallet: string,
): Promise<string> {
  const lower = wallet.toLowerCase();
  const existing = await db
    .select()
    .from(referralCodes)
    .where(eq(referralCodes.wallet, lower))
    .limit(1);

  if (existing[0]) return existing[0].code;

  // Short, URL-safe code derived from the wallet — collisions are
  // astronomically unlikely at this address space but the unique
  // constraint on referralCodes.code is the real backstop.
  const code = lower.slice(2, 10);

  const [row] = await db
    .insert(referralCodes)
    .values({ id: randomUUID(), wallet: lower, code })
    .onConflictDoNothing({ target: referralCodes.wallet })
    .returning();

  return row?.code ?? code;
}

export async function getReferrerByCode(
  db: CampaignDbClient,
  code: string,
): Promise<string | undefined> {
  const result = await db.select().from(referralCodes).where(eq(referralCodes.code, code)).limit(1);
  return result[0]?.wallet;
}

export async function countReferralCredits(
  db: CampaignDbClient,
  referrerWallet: string,
): Promise<number> {
  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(referralCredits)
    .where(eq(referralCredits.referrerWallet, referrerWallet.toLowerCase()));
  return result[0]?.count ?? 0;
}

/**
 * Records a referral credit. Fails silently (no row) if referredWallet has
 * already been credited to any referrer — the unique constraint on
 * referred_wallet is what enforces "one credit per referred wallet, ever."
 */
export async function insertReferralCredit(
  db: CampaignDbClient,
  input: {
    referrerWallet: string;
    referredWallet: string;
    tier: "full" | "half" | "floor";
    basePoints: number;
    weightedPoints: number;
  },
): Promise<ReferralCreditRow | undefined> {
  const [row] = await db
    .insert(referralCredits)
    .values({
      id: randomUUID(),
      referrerWallet: input.referrerWallet.toLowerCase(),
      referredWallet: input.referredWallet.toLowerCase(),
      tier: input.tier,
      basePoints: input.basePoints,
      weightedPoints: input.weightedPoints,
    })
    .onConflictDoNothing({ target: referralCredits.referredWallet })
    .returning();
  return row;
}

// ─── Social bonus ───────────────────────────────────────────────────────────

export async function upsertSocialBonus(
  db: CampaignDbClient,
  input: { wallet: string; galxeQuestId: string; points: number },
): Promise<void> {
  await db
    .insert(socialBonus)
    .values({ id: randomUUID(), ...input, wallet: input.wallet.toLowerCase() })
    .onConflictDoNothing();
}

// ─── Snapshot ───────────────────────────────────────────────────────────────

export async function writeSnapshot(
  db: CampaignDbClient,
  wallet: string,
  totalPoints: number,
): Promise<SnapshotRow> {
  const [row] = await db
    .insert(snapshots)
    .values({ id: randomUUID(), wallet: wallet.toLowerCase(), totalPoints })
    .onConflictDoUpdate({ target: snapshots.wallet, set: { totalPoints, frozenAt: new Date() } })
    .returning();
  return row;
}

export async function getSnapshotForWallet(
  db: CampaignDbClient,
  wallet: string,
): Promise<SnapshotRow | undefined> {
  const result = await db.select().from(snapshots).where(eq(snapshots.wallet, wallet.toLowerCase())).limit(1);
  return result[0];
}

// ─── Redemptions ────────────────────────────────────────────────────────────

export async function getRedemptionByWallet(
  db: CampaignDbClient,
  wallet: string,
): Promise<RedemptionRow | undefined> {
  const result = await db.select().from(redemptions).where(eq(redemptions.wallet, wallet.toLowerCase())).limit(1);
  return result[0];
}

export async function createRedemptionRequest(
  db: CampaignDbClient,
  input: { wallet: string; pointsRedeemed: number; ethAmountWei: string },
): Promise<RedemptionRow | undefined> {
  const [row] = await db
    .insert(redemptions)
    .values({ id: randomUUID(), ...input, wallet: input.wallet.toLowerCase() })
    .onConflictDoNothing({ target: redemptions.wallet })
    .returning();
  return row;
}

export async function markRedemptionApproved(
  db: CampaignDbClient,
  wallet: string,
): Promise<void> {
  await db
    .update(redemptions)
    .set({ status: "approved", approvedAt: new Date() })
    .where(and(eq(redemptions.wallet, wallet.toLowerCase()), eq(redemptions.status, "pending")));
}

export async function markRedemptionPaid(
  db: CampaignDbClient,
  wallet: string,
  txHash: string,
): Promise<void> {
  await db
    .update(redemptions)
    .set({ status: "paid", paidAt: new Date(), txHash })
    .where(eq(redemptions.wallet, wallet.toLowerCase()));
}

/** Sum of ethAmountWei across every row already marked "approved" or "paid" — used to enforce the treasury budget cap before approving new claims. */
export async function getCommittedTreasuryWei(db: CampaignDbClient): Promise<bigint> {
  const rows = await db
    .select({ ethAmountWei: redemptions.ethAmountWei })
    .from(redemptions)
    .where(sql`${redemptions.status} in ('approved', 'paid')`);

  return rows.reduce((sum, r) => sum + BigInt(r.ethAmountWei), 0n);
}
