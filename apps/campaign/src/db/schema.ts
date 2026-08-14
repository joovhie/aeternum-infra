/**
 * src/db/schema.ts
 *
 * Campaign's OWN tables — everything here is owned and migrated by
 * apps/campaign via drizzle-kit, living in a separate "campaign" Postgres
 * schema in the same database Ponder writes to. This is deliberately
 * NOT added to packages/db: those tables mirror what Ponder creates and
 * are migrated by Ponder itself. Mixing a Ponder-owned migration surface
 * with a drizzle-kit-owned one is the kind of thing that looks fine until
 * the two migration tools fight over the same schema.
 *
 * To read the Ponder-owned tables (vaults, vault_transactions,
 * balance_events) for scoring, see src/indexerReads/queries.ts, which
 * imports @aeternum/db as-is.
 */

import { pgSchema, text, integer, timestamp, numeric, unique } from "drizzle-orm/pg-core";

export const campaignSchema = pgSchema("campaign");

// ─── Points ledger ──────────────────────────────────────────────────────────
// Append-only. One row per earned action. Never update a row's points after
// insert — if a scoring rule changes, adjust future rows and reconcile via
// a new row, not a mutation. That's what makes a dispute auditable later.

export const pointsLedger = campaignSchema.table(
  "points_ledger",
  {
    id:             text("id").primaryKey(),
    wallet:         text("wallet").notNull(),          // always stored lowercased
    phase:          text("phase").notNull(),            // "sepolia" | "mainnet"
    actionType:     text("action_type").notNull(),      // see scoring/weights.ts ACTION_TYPES
    basePoints:     integer("base_points").notNull(),
    weight:         numeric("weight", { precision: 10, scale: 4 }).notNull(),
    weightedPoints: integer("weighted_points").notNull(),
    // Dedupe key: a tx hash, bug report id, or referral credit id.
    reference:      text("reference").notNull(),
    createdAt:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // A re-run of a scoring job must never double-count the same event —
    // this is the constraint that makes computePoints.ts idempotent.
    dedupe: unique("points_ledger_wallet_action_reference").on(
      table.wallet,
      table.actionType,
      table.reference,
    ),
  }),
);

// ─── Bug reports ────────────────────────────────────────────────────────────
// Deliberately excludes any "contract / security" category. Anything
// touching contract security goes to security@aeternumvault.xyz only —
// never through this table. See src/api/routes/bugReports.ts.

export const bugReports = campaignSchema.table("bug_reports", {
  id:            text("id").primaryKey(),
  wallet:        text("wallet").notNull(),
  category:      text("category").notNull(),   // "ui" | "indexer" | "docs" | "other"
  title:         text("title").notNull(),
  description:   text("description").notNull(),
  severity:      text("severity").notNull(),    // "low" | "medium" | "high"
  status:        text("status").notNull().default("submitted"), // submitted|reviewing|accepted|rejected|duplicate
  reviewedBy:    text("reviewed_by"),
  pointsAwarded: integer("points_awarded"),
  submittedAt:   timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
  reviewedAt:    timestamp("reviewed_at", { withTimezone: true }),
});

// ─── Referrals ──────────────────────────────────────────────────────────────
// One code per wallet (referral_codes), many credits per code
// (referral_credits) — a referred wallet can only ever be credited once,
// to one referrer, which is what makes the decay tier stable per referrer.

export const referralCodes = campaignSchema.table("referral_codes", {
  id:        text("id").primaryKey(),
  wallet:    text("wallet").notNull().unique(),
  code:      text("code").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const referralCredits = campaignSchema.table("referral_credits", {
  id:             text("id").primaryKey(),
  referrerWallet: text("referrer_wallet").notNull(),
  referredWallet: text("referred_wallet").notNull().unique(), // one credit per referred wallet, ever
  tier:           text("tier").notNull(),          // "full" | "half" | "floor"
  basePoints:     integer("base_points").notNull(),
  weightedPoints: integer("weighted_points").notNull(),
  creditedAt:     timestamp("credited_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Social bonus (Galxe) ───────────────────────────────────────────────────

export const socialBonus = campaignSchema.table("social_bonus", {
  id:           text("id").primaryKey(),
  wallet:       text("wallet").notNull(),
  galxeQuestId: text("galxe_quest_id").notNull(),
  points:       integer("points").notNull(),
  syncedAt:     timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Snapshot ───────────────────────────────────────────────────────────────
// One row per wallet, written once by the (manually-triggered) freeze job
// at the close of the mainnet phase. This table, once written, is the
// canonical record redemption pays out against — the live points_ledger
// can keep changing after this point and it must not matter.

export const snapshots = campaignSchema.table("snapshots", {
  id:          text("id").primaryKey(),
  wallet:      text("wallet").notNull().unique(),
  totalPoints: integer("total_points").notNull(),
  frozenAt:    timestamp("frozen_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Redemptions ────────────────────────────────────────────────────────────
// Pull-based: a wallet requests a claim, the executor validates and marks it
// approved for the treasury Safe's signers to co-sign — see
// src/redemption/executor.ts for why this isn't fully automated.

export const redemptions = campaignSchema.table("redemptions", {
  id:              text("id").primaryKey(),
  wallet:          text("wallet").notNull().unique(),  // one redemption per wallet
  pointsRedeemed:  integer("points_redeemed").notNull(),
  ethAmountWei:    text("eth_amount_wei").notNull(),   // stored as string — no float precision on real ETH amounts
  status:          text("status").notNull().default("pending"), // pending|approved|paid|rejected
  requestedAt:     timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  approvedAt:      timestamp("approved_at", { withTimezone: true }),
  paidAt:          timestamp("paid_at", { withTimezone: true }),
  txHash:          text("tx_hash"),
});

export type PointsLedgerRow   = typeof pointsLedger.$inferSelect;
export type BugReportRow      = typeof bugReports.$inferSelect;
export type ReferralCodeRow   = typeof referralCodes.$inferSelect;
export type ReferralCreditRow = typeof referralCredits.$inferSelect;
export type SocialBonusRow    = typeof socialBonus.$inferSelect;
export type SnapshotRow       = typeof snapshots.$inferSelect;
export type RedemptionRow     = typeof redemptions.$inferSelect;
