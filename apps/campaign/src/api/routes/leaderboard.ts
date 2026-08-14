/**
 * src/api/routes/leaderboard.ts
 */

import { Hono } from "hono";
import type { CampaignDbClient } from "../../db/client.js";
import { getLeaderboard } from "../../db/queries.js";

export function leaderboardRoutes(db: CampaignDbClient) {
  const app = new Hono();

  app.get("/", async (c) => {
    const limitParam = c.req.query("limit");
    const limit = limitParam ? Math.min(Number(limitParam), 500) : 100;
    const rows = await getLeaderboard(db, limit);
    return c.json({ leaderboard: rows });
  });

  return app;
}
