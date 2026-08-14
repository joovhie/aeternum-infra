/**
 * src/index.ts
 *
 * Keeper bot entry point.
 *
 * STARTUP SEQUENCE:
 *   1. Validate keeper-specific env (KEEPER_PRIVATE_KEY + optional overrides).
 *      Shared env (CHAIN_ID, RPC_URL, CONTRACT_ADDRESS, DATABASE_URL) is
 *      already validated by @aeternum/config on import.
 *   2. Instantiate viem clients and the database client.
 *   3. Start a minimal HTTP health server (used by Render's health check).
 *   4. Enter the polling loop: scan → execute → sleep → repeat.
 *
 * GRACEFUL SHUTDOWN:
 *   SIGTERM — finish the current cycle, then exit cleanly. Render sends
 *   SIGTERM before force-killing a service; this gives the bot time to
 *   complete any in-progress transaction before stopping.
 *   SIGINT  — exit immediately (local Ctrl-C).
 *
 * MULTI-CHAIN NOTE: this keeper deployment operates on exactly one chain,
 * the one env.CHAIN_ID points at — see scanner.ts's multi-chain update.
 * Once mainnet is live, mainnet recovery execution is a second keeper
 * deployment with its own env (its own CHAIN_ID, RPC_URL, CONTRACT_ADDRESS,
 * KEEPER_PRIVATE_KEY, and funded gas wallet), not a code change here.
 */

import http from "node:http";
import { z } from "zod";
import { env, KEEPER_DEFAULTS } from "@aeternum/config";
import { createViemPublicClient, createViemWalletClient } from "@aeternum/blockchain";
import { createDbClient } from "@aeternum/db";
import { scan } from "./scanner.js";
import { execute } from "./executor.js";
import { logger } from "./logger.js";

// --- Keeper-specific env ---
// Shared env (CHAIN_ID, RPC_URL, etc.) is validated by packages/config.
// Only keeper-specific variables are validated here.

const keeperEnvSchema = z.object({
  KEEPER_PRIVATE_KEY: z
    .string()
    .trim()
    .regex(
      /^(0x)?[a-fA-F0-9]{64}$/,
      "KEEPER_PRIVATE_KEY must be a 32-byte hex string (with or without 0x prefix)",
    )
    .transform((val) =>
      (val.startsWith("0x") ? val : `0x${val}`) as `0x${string}`,
    ),

  // Optional overrides — default to values from packages/config/src/constants.ts
  KEEPER_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(KEEPER_DEFAULTS.POLL_INTERVAL_MS),

  KEEPER_BATCH_SIZE: z.coerce
    .number()
    .int()
    .positive()
    .default(KEEPER_DEFAULTS.BATCH_SIZE),
});

const keeperParsed = keeperEnvSchema.safeParse(process.env);

if (!keeperParsed.success) {
  logger.error("Invalid keeper environment variables", {
    errors: keeperParsed.error.flatten().fieldErrors,
  });
  process.exit(1);
}

const keeperEnv = keeperParsed.data;
const contractAddress = env.CONTRACT_ADDRESS as `0x${string}`;

// --- Clients ---
const publicClient = createViemPublicClient(env.RPC_URL, env.CHAIN_ID);
const walletClient = createViemWalletClient(
  env.RPC_URL,
  env.CHAIN_ID,
  keeperEnv.KEEPER_PRIVATE_KEY,
);
const db = createDbClient(env.DATABASE_URL);

// --- Health server ---
// Render uses this endpoint to confirm the service is running.
// Uses Node's built-in http module — no extra dependency.
// PORT is set automatically by Render for web-exposed services;
// falls back to 3001 for local development.

const PORT = Number(process.env.PORT ?? 3001);

const healthServer = http.createServer((req, res) => {
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

healthServer.listen(PORT, () => {
  logger.info("Health server listening", { port: PORT });
});

// --- Keeper cycle ---
async function runCycle(): Promise<void> {
  logger.info("Keeper: cycle started");

  const dueWallets = await scan(
    db,
    env.CHAIN_ID,
    publicClient,
    contractAddress,
    keeperEnv.KEEPER_BATCH_SIZE,
  );

  if (dueWallets.length === 0) {
    logger.info("Keeper: no due vaults found this cycle");
    return;
  }

  logger.info("Keeper: due vaults confirmed, executing", {
    count: dueWallets.length,
  });

  await execute(walletClient, publicClient, contractAddress, dueWallets);

  logger.info("Keeper: cycle complete");
}

// --- Main loop ---
let running = true;

process.on("SIGTERM", () => {
  logger.info("Keeper: SIGTERM received — will stop after current cycle");
  running = false;
});

process.on("SIGINT", () => {
  logger.info("Keeper: SIGINT received — stopping");
  healthServer.close();
  process.exit(0);
});

logger.info("Keeper: starting", {
  chainId: env.CHAIN_ID,
  contractAddress,
  pollIntervalMs: keeperEnv.KEEPER_POLL_INTERVAL_MS,
  batchSize: keeperEnv.KEEPER_BATCH_SIZE,
});

(async () => {
  while (running) {
    try {
      await runCycle();
    } catch (err) {
      // Surface unhandled errors without crashing the loop.
      // Render's restart policy handles persistent failures.
      logger.error("Keeper: unhandled cycle error", {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }

    if (!running) break;

    await new Promise<void>((resolve) =>
      setTimeout(resolve, keeperEnv.KEEPER_POLL_INTERVAL_MS),
    );
  }

  logger.info("Keeper: shutdown complete");
  healthServer.close();
  process.exit(0);
})();
