/**
 * src/api/routes/referrals.ts
 */

import { Hono } from "hono";
import { z } from "zod";
import type { CampaignDbClient } from "../../db/client.js";
import { getOrCreateReferralCode, getReferrerByCode, countReferralCredits, insertReferralCredit } from "../../db/queries.js";
import { insertLedgerEntries } from "../../db/queries.js";
import { referralTier, REFERRAL_BASE_POINTS, PHASE_WEIGHTS } from "../../scoring/weights.js";
import { underDailyRateLimit, passesFundingSourceCheck } from "../../scoring/antiGaming.js";

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);

export function referralsRoutes(db: CampaignDbClient) {
  const app = new Hono();

  app.get("/:wallet/code", async (c) => {
    const parsed = addressSchema.safeParse(c.req.param("wallet"));
    if (!parsed.success) return c.json({ error: "wallet must be a valid Ethereum address" }, 400);

    const code = await getOrCreateReferralCode(db, parsed.data);
    return c.json({ wallet: parsed.data.toLowerCase(), code });
  });

  /**
   * Credits a referral. Called by the frontend once the REFERRED wallet has
   * completed real registration + a real deposit on mainnet — never on
   * click-through. That gating happens upstream of this route; this route
   * assumes it's already been verified and just records the credit.
   */
  app.post("/credit", async (c) => {
    const body = await c.req.json().catch(() => null);
    const schema = z.object({ code: z.string(), referredWallet: addressSchema });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ error: "code and referredWallet are required" }, 400);

    const referrerWallet = await getReferrerByCode(db, parsed.data.code);
    if (!referrerWallet) return c.json({ error: "unknown referral code" }, 404);
    if (referrerWallet.toLowerCase() === parsed.data.referredWallet.toLowerCase()) {
      return c.json({ error: "cannot refer yourself" }, 400);
    }

    if (!(await underDailyRateLimit(db, referrerWallet))) {
      return c.json({ error: "referrer rate limit exceeded" }, 429);
    }
    if (!(await passesFundingSourceCheck(parsed.data.referredWallet))) {
      return c.json({ error: "referred wallet failed funding-source check" }, 400);
    }

    const existingCount = await countReferralCredits(db, referrerWallet);
    const { tier, multiplier } = referralTier(existingCount);
    const basePoints = Math.round(REFERRAL_BASE_POINTS * multiplier);

    const credit = await insertReferralCredit(db, {
      referrerWallet,
      referredWallet: parsed.data.referredWallet,
      tier,
      basePoints,
      weightedPoints: Math.round(basePoints * PHASE_WEIGHTS.mainnet),
    });

    if (!credit) {
      return c.json({ error: "referredWallet has already been credited" }, 409);
    }

    await insertLedgerEntries(db, [
      {
        wallet: referrerWallet,
        phase: "mainnet",
        actionType: "REFERRAL",
        basePoints,
        weight: PHASE_WEIGHTS.mainnet,
        reference: credit.id,
      },
    ]);

    return c.json({ credited: true, tier, basePoints });
  });

  return app;
}
