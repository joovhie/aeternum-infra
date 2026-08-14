/**
 * src/api/app.ts
 *
 * Assembles the Hono app. Follows apps/indexer/src/api/index.ts's pattern
 * (a Hono instance with mounted sub-routers) — the difference is this app
 * is served standalone via @hono/node-server in src/index.ts, since
 * campaign isn't hosted inside Ponder's runtime the way the indexer's API
 * is.
 */

import { Hono } from "hono";
import type { CampaignDbClient } from "../db/client.js";
import { leaderboardRoutes } from "./routes/leaderboard.js";
import { pointsRoutes } from "./routes/points.js";
import { referralsRoutes } from "./routes/referrals.js";
import { bugReportsRoutes } from "./routes/bugReports.js";
import { redemptionRoutes } from "./routes/redemption.js";

export function buildApp(db: CampaignDbClient) {
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.route("/leaderboard", leaderboardRoutes(db));
  app.route("/points", pointsRoutes(db));
  app.route("/referrals", referralsRoutes(db));
  app.route("/bug-reports", bugReportsRoutes(db));
  app.route("/redemption", redemptionRoutes(db));

  return app;
}
