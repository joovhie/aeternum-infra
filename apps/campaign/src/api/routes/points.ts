/**
 * src/api/routes/points.ts
 */

import { Hono } from "hono";
import type { CampaignDbClient } from "../../db/client.js";
import { getPointsByWallet, getLedgerForWallet } from "../../db/queries.js";

export function pointsRoutes(db: CampaignDbClient) {
  const app = new Hono();

  app.get("/:wallet", async (c) => {
    const wallet = c.req.param("wallet");
    if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
      return c.json({ error: "wallet must be a valid Ethereum address" }, 400);
    }

    const [byPhase, ledger] = await Promise.all([
      getPointsByWallet(db, wallet),
      getLedgerForWallet(db, wallet),
    ]);

    return c.json({
      wallet: wallet.toLowerCase(),
      byPhase,
      total: byPhase.reduce((sum, p) => sum + p.total, 0),
      ledger,
    });
  });

  return app;
}
