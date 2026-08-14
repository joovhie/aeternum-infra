/**
 * src/scoring/weights.ts
 *
 * All point values and the referral decay curve in one place, deliberately
 * separate from the logic that applies them (computePoints.ts). Anything
 * with a "TBD" note is a placeholder pending an actual business decision —
 * grep for TBD before this ever runs against real money.
 */

import { campaignEnv } from "../env.js";

// ─── Phase weights ──────────────────────────────────────────────────────────

export const PHASE_WEIGHTS = {
  sepolia: 1,
  mainnet: campaignEnv.CAMPAIGN_MAINNET_WEIGHT_MULTIPLIER,
} as const;

export type Phase = keyof typeof PHASE_WEIGHTS;

// ─── Action types ───────────────────────────────────────────────────────────
// Sepolia-phase (mirrors the vault_transactions.type vocabulary directly —
// see apps/indexer/src/index.ts for the source of truth on these strings).

export const SEPOLIA_ACTION_POINTS = {
  REGISTERED: 10,
  CORE_RECOVERY_CYCLE: 100, // register → deposit → wait → keeper-executed recovery, full loop
  EDGE_CASE_REPRODUCTION: 150, // three-attempt failure cycle, cancel-on-zero-balance, re-registration, etc.
} as const;

// Mainnet-phase.
export const MAINNET_ACTION_POINTS = {
  REGISTER_DEPOSIT_BASE: 50, // base unit before the log-scale deposit-size bonus below
  LIVENESS_CHECKPOINT: 20,   // per month confirmed still registered, funded, not failed/abandoned/cancelled
} as const;

export const REFERRAL_BASE_POINTS = 30; // TBD — full-tier value; tune once dust threshold is locked

// ─── Referral decay curve ───────────────────────────────────────────────────
// Full points for the first 10 real-deposit referrals, half for the next 10,
// a fixed floor after that. No hard wall — see the campaign plan's "Reward
// parameters" section for the reasoning.

export function referralTier(existingCreditCount: number): { tier: "full" | "half" | "floor"; multiplier: number } {
  if (existingCreditCount < 10) return { tier: "full", multiplier: 1 };
  if (existingCreditCount < 20) return { tier: "half", multiplier: 0.5 };
  return { tier: "floor", multiplier: 0.1 };
}

// ─── Deposit-size bonus (mainnet registration) ─────────────────────────────
/**
 * Log-scaled bonus on top of REGISTER_DEPOSIT_BASE, so the mainnet
 * registration bonus rewards genuine deposits without turning into a
 * linear "whoever deposits the most wins" contest. Deposits at or below
 * the dust threshold earn the base amount only; each further doubling of
 * deposit size adds a fixed increment, capped at MAX_MULTIPLIER.
 */
const MAX_DEPOSIT_MULTIPLIER = 4;

export function depositSizeMultiplier(depositWei: bigint): number {
  const dust = campaignEnv.CAMPAIGN_DEPOSIT_DUST_THRESHOLD_WEI;
  if (depositWei <= dust || dust === 0n) return 1;

  const ratio = Number(depositWei) / Number(dust);
  const multiplier = 1 + Math.log2(ratio);
  return Math.min(Math.max(multiplier, 1), MAX_DEPOSIT_MULTIPLIER);
}
