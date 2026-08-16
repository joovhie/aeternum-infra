/**
 * src/env.ts
 *
 * Campaign-specific env validation. Shared env (CHAIN_ID, RPC_URL,
 * CONTRACT_ADDRESS, DATABASE_URL, etc.) is already validated by
 * @aeternum/config on import — only campaign-only variables live here,
 * same split as apps/keeper/src/index.ts uses for KEEPER_PRIVATE_KEY.
 *
 * A few values below (marked TBD) are deliberately left without a
 * business-decided default. Anti-gaming and payout parameters that get a
 * silent default instead of an explicit one are the kind of thing that
 * quietly become policy — better to fail loudly until someone sets them.
 */

import { z } from "zod";
import { logger } from "./logger.js";

const campaignEnvSchema = z.object({
  // --- HTTP ---
  PORT: z.coerce.number().int().positive().default(3002),

  // --- Reward weighting ---
  // Multiplier applied to mainnet-phase points relative to Sepolia-phase
  // points (Sepolia = 1x baseline). Ratio is TBD per the campaign plan —
  // this default is a placeholder for local dev only, not a locked value.
  CAMPAIGN_MAINNET_WEIGHT_MULTIPLIER: z.coerce.number().positive().default(3),

  // Minimum real deposit (in wei) for a mainnet registration to earn the
  // phase-2 registration bonus. TBD — placeholder guards against a zero
  // threshold silently allowing dust-deposit farming.
  CAMPAIGN_DEPOSIT_DUST_THRESHOLD_WEI: z.coerce
    .bigint()
    .nonnegative()
    .default(1_000_000_000_000_000n), // 0.001 ETH placeholder

  // How long a deposit must remain in the vault before it counts toward
  // points — blunts deposit-then-immediately-withdraw farming.
  CAMPAIGN_MIN_HOLD_SECONDS: z.coerce.number().int().nonnegative().default(86_400),

  // Total ETH (in wei) available for redemption payouts. TBD — locked at
  // seed close per the campaign plan. Zero is a safe default: it forces
  // the redemption executor to reject every claim until this is set
  // deliberately, rather than draining an unbounded treasury.
  CAMPAIGN_TREASURY_BUDGET_WEI: z.coerce.bigint().nonnegative().default(0n),

  // Points → ETH conversion rate, in wei per point. TBD per the campaign
  // plan — set once budget and participation are known, not before. Zero
  // is the safe default: every redemption computes to 0 wei until this is
  // set deliberately, rather than an arbitrary guessed rate going live.
  CAMPAIGN_POINTS_TO_WEI_RATE: z.coerce.bigint().nonnegative().default(0n),

  // Minimal shared-secret auth for the admin-only redemption-approval and
  // bug-report-review endpoints. This is a placeholder, not real auth —
  // fine for a small internal team hitting these by hand or via a script,
  // not something to leave as the only gate once anyone else touches this.
  CAMPAIGN_ADMIN_API_KEY: z.string().min(1).optional(),

  // --- Treasury ---
  // Safe (multisig) address that holds and pays out redemption ETH.
  // The campaign service never holds a hot key capable of moving this
  // treasury directly — see src/redemption/treasury.ts.
  CAMPAIGN_TREASURY_SAFE_ADDRESS: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "CAMPAIGN_TREASURY_SAFE_ADDRESS must be a valid Ethereum address")
    .optional(),

  // --- Galxe integration ---
  GALXE_ACCESS_TOKEN: z.string().min(1).optional(),
  GALXE_SPACE_ID: z.string().min(1).optional(),
  GALXE_CAMPAIGN_ID: z.string().min(1).optional(),
  GALXE_API_URL: z.string().url().default("https://graphigo-business.prd.galaxy.eco/query"),

  // --- Multi-chain gate ---
  // Set to "true" once apps/indexer is actually tracking mainnet (see its
  // ponder.config.ts mainnetConfigured gate). Until then, mainnet-scoped
  // jobs (mainnet registration scoring, the liveness checkpoint) skip
  // themselves explicitly rather than running against a chain with no
  // indexed data and silently awarding nothing every time.
  MAINNET_INDEXING_LIVE: z
  .string()
  .optional()
  .default("false")
  .transform((val) => val === "true"),
});

const campaignParsed = campaignEnvSchema.safeParse(process.env);

if (!campaignParsed.success) {
  logger.error("Invalid campaign environment variables", {
    errors: campaignParsed.error.flatten().fieldErrors,
  });
  process.exit(1);
}

export const campaignEnv = campaignParsed.data;
export type CampaignEnv = typeof campaignEnv;
