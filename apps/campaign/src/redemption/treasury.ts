/**
 * src/redemption/treasury.ts
 *
 * Wraps the treasury Safe. Deliberately does NOT hold a hot key capable of
 * moving redemption funds unilaterally — the campaign plan calls for a
 * semi-manual batch flow where the multisig's own signers co-sign payouts,
 * not a bot spraying a treasury. That's a different trust model than the
 * keeper (which only ever moves funds that were never Aeternum's to begin
 * with — permissionless recovery, not a payout from Aeternum's own
 * treasury).
 *
 * NOT IMPLEMENTED — proposeSafeTransaction below is a stub. Real Safe
 * integration (via @safe-global/protocol-kit or the Safe Transaction
 * Service API) needs an actual deployed Safe address and configured
 * owners, which don't exist yet. This function exists so the rest of the
 * redemption flow can be built and tested against it now, with a clear
 * seam to swap in the real Safe SDK call later.
 */

import { logger } from "../logger.js";
import { campaignEnv } from "../env.js";

export interface PayoutIntent {
  wallet: `0x${string}`;
  amountWei: bigint;
  redemptionId: string;
}

export async function proposeSafeTransaction(intent: PayoutIntent): Promise<void> {
  if (!campaignEnv.CAMPAIGN_TREASURY_SAFE_ADDRESS) {
    throw new Error("CAMPAIGN_TREASURY_SAFE_ADDRESS is not set — cannot propose a payout");
  }

  logger.warn("proposeSafeTransaction is a stub — no real Safe transaction was proposed", {
    safe: campaignEnv.CAMPAIGN_TREASURY_SAFE_ADDRESS,
    wallet: intent.wallet,
    amountWei: intent.amountWei.toString(),
    redemptionId: intent.redemptionId,
  });

  // TODO: replace with a real Safe Transaction Service proposal once the
  // treasury Safe exists — e.g. via @safe-global/protocol-kit's
  // createTransaction + proposeTransaction, signed by whichever signer
  // this service is configured to act as one-of.
}
