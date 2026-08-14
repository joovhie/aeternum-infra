/**
 * src/index.ts
 *
 * Campaign API service entry point.
 *
 * Unlike the keeper (a polling loop with a side health endpoint), campaign
 * IS the API service — the Hono app carries both /health and the real
 * routes together, served via @hono/node-server. Scheduled work (nightly
 * scoring, monthly liveness, Galxe sync, snapshot freeze) does NOT run in
 * this process — those are separate scripts under src/jobs/, meant to run
 * as Render Cron Jobs, not a long-lived loop like the keeper's.
 *
 * GRACEFUL SHUTDOWN: SIGTERM and SIGINT both close the HTTP server and
 * exit — there's no in-progress cycle to finish the way the keeper has,
 * since every request here is short-lived.
 */

import { serve } from "@hono/node-server";
import { env } from "@aeternum/config";
import { createDbClient } from "@aeternum/db";
import { createCampaignDbClient } from "./db/client.js";
import { buildApp } from "./api/app.js";
import { campaignEnv } from "./env.js";
import { logger } from "./logger.js";

// Instantiated for parity with the rest of the monorepo and to fail fast if
// DATABASE_URL can't reach the indexer's tables — not currently used
// directly by the API routes (they only touch campaign's own tables), but
// scoring code reached from admin/debug routes in the future will need it
// instantiated once, here, rather than per-request.
const indexerDb = createDbClient(env.DATABASE_URL);
void indexerDb;

const campaignDb = createCampaignDbClient(env.DATABASE_URL);
const app = buildApp(campaignDb);

const server = serve({ fetch: app.fetch, port: campaignEnv.PORT }, (info) => {
  logger.info("Campaign API listening", { port: info.port, chainId: env.CHAIN_ID });
});

function shutdown(signal: string) {
  logger.info(`Campaign: ${signal} received — shutting down`);
  server.close(() => {
    logger.info("Campaign: shutdown complete");
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
