/**
 * src/api/routes/redemption.ts
 */

import { Hono } from "hono";
import type { CampaignDbClient } from "../../db/client.js";
import { getRedemptionByWallet } from "../../db/queries.js";
import { requestRedemption, approveAndProposePayout } from "../../redemption/executor.js";
import { campaignEnv } from "../../env.js";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export function redemptionRoutes(db: CampaignDbClient) {
  const app = new Hono();

  app.get("/:wallet", async (c) => {
    const wallet = c.req.param("wallet");
    if (!ADDRESS_RE.test(wallet)) return c.json({ error: "invalid wallet" }, 400);
    const row = await getRedemptionByWallet(db, wallet);
    return c.json({ redemption: row ?? null });
  });

  app.post("/:wallet/claim", async (c) => {
    const wallet = c.req.param("wallet");
    if (!ADDRESS_RE.test(wallet)) return c.json({ error: "invalid wallet" }, 400);

    const result = await requestRedemption(db, wallet as `0x${string}`);
    if (!result.ok) return c.json({ error: result.reason }, 400);
    return c.json(result);
  });

  // Admin-only — approves a pending request and proposes the Safe payout.
  // See env.ts's note: CAMPAIGN_ADMIN_API_KEY is a placeholder gate, not
  // real auth.
  app.post("/:wallet/approve", async (c) => {
    if (!campaignEnv.CAMPAIGN_ADMIN_API_KEY || c.req.header("x-admin-key") !== campaignEnv.CAMPAIGN_ADMIN_API_KEY) {
      return c.json({ error: "unauthorized" }, 401);
    }

    const wallet = c.req.param("wallet");
    if (!ADDRESS_RE.test(wallet)) return c.json({ error: "invalid wallet" }, 400);

    try {
      await approveAndProposePayout(db, wallet as `0x${string}`);
      return c.json({ approved: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "approval failed" }, 400);
    }
  });

  return app;
}
