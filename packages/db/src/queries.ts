/**
 * src/queries.ts
 *
 * Two responsibilities:
 *
 * 1. Mirror table definitions — Ponder owns the actual schema and runs
 *    migrations. These pgTable definitions must exactly match what Ponder
 *    creates in PostgreSQL. Ponder converts camelCase property names to
 *    snake_case column names automatically, so each column is declared with
 *    its explicit snake_case name. If ponder.schema.ts changes, update the
 *    corresponding table here.
 *
 * 2. Query helpers — typed functions over those tables for use by the keeper
 *    and any future services that read from the indexed database.
 *
 * MULTI-CHAIN UPDATE: vaults.id is now `${chainId}-${wallet}`, not the bare
 * wallet address — see apps/indexer/ponder.schema.ts. getDueVaults,
 * getVaultByAddress, and getActiveVaultCount all now take a required
 * chainId parameter and filter on it. This is a breaking signature change
 * for every caller — apps/keeper/src/scanner.ts has been updated
 * accordingly; check for any other callers before deploying.
 */

import {
  pgTable,
  text,
  bigint,
  boolean,
  integer,
} from "drizzle-orm/pg-core";
import { and, eq, sql } from "drizzle-orm";
import type { DbClient } from "./client.js";

// --- Table mirrors ---
// These mirror apps/indexer/ponder.schema.ts exactly.
// Ponder table name → PostgreSQL table name: camelCase → snake_case.

export const vaults = pgTable("vaults", {
  id:                   text("id").primaryKey(),                          // `${chainId}-${wallet}`
  chainId:              integer("chain_id").notNull(),
  wallet:               text("wallet").notNull(),                          // bare wallet address — query this, not id
  backupAddress:        text("backup_address").notNull(),
  inactivityPeriod:     bigint("inactivity_period", { mode: "bigint" }).notNull(),
  lastActivityTimestamp:bigint("last_activity_timestamp", { mode: "bigint" }).notNull(),
  isRecovered:          boolean("is_recovered").notNull().default(false),
  isAbandoned:          boolean("is_abandoned").notNull().default(false),
  isCancelled:          boolean("is_cancelled").notNull().default(false),
  createdAtBlock:       bigint("created_at_block", { mode: "bigint" }).notNull(),
});

export const vaultTransactions = pgTable("vault_transactions", {
  id:              text("id").primaryKey(),                               // txHash-logIndex
  chainId:         integer("chain_id").notNull(),
  wallet:          text("wallet").notNull(),
  type:            text("type").notNull(),
  amount:          bigint("amount", { mode: "bigint" }),
  toAddress:       text("to_address"),
  transactionHash: text("transaction_hash").notNull(),
  blockNumber:     bigint("block_number", { mode: "bigint" }).notNull(),
  timestamp:       bigint("timestamp", { mode: "bigint" }).notNull(),
});

export const balanceEvents = pgTable("balance_events", {
  id:             text("id").primaryKey(),
  chainId:        integer("chain_id").notNull(),
  vaultId:        text("vault_id").notNull(),                             // bare wallet address, unchanged
  eventName:      text("event_name").notNull(),
  blockNumber:    bigint("block_number", { mode: "bigint" }).notNull(),
  logIndex:       integer("log_index").notNull(),
  blockTimestamp: bigint("block_timestamp", { mode: "bigint" }).notNull(),
  amount:         bigint("amount", { mode: "bigint" }),
});

// --- Types ---

export type Vault = typeof vaults.$inferSelect;
export type VaultTransaction = typeof vaultTransactions.$inferSelect;
export type BalanceEvent = typeof balanceEvents.$inferSelect;

// --- Query helpers ---

/**
 * Returns all vaults on the given chain whose inactivity deadline has
 * passed and that have not yet been recovered, abandoned, or cancelled.
 *
 * Deadline condition: lastActivityTimestamp + inactivityPeriod <= now (unix seconds)
 *
 * This is the keeper bot's primary pre-filter. It identifies candidates from
 * the indexed database before the keeper submits triggerRecovery on-chain.
 * The contract re-validates all conditions independently — this query is an
 * efficiency layer, not a security boundary.
 *
 * @param db      Drizzle client from createDbClient()
 * @param chainId Numeric EVM chain ID to scan — a keeper deployment only
 *                ever acts on its own chain, so this must be passed
 *                explicitly rather than defaulted, to avoid a
 *                misconfigured deployment silently scanning the wrong
 *                chain's vaults.
 * @param limit   Max rows to return per call. Defaults to 500.
 * @param offset  Pagination offset for iterating over large result sets.
 */
export async function getDueVaults(
  db: DbClient,
  chainId: number,
  limit = 500,
  offset = 0,
): Promise<Vault[]> {
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));

  return db
    .select()
    .from(vaults)
    .where(
      and(
        eq(vaults.chainId, chainId),
        // Deadline elapsed: lastActivityTimestamp + inactivityPeriod <= now
        sql`(${vaults.lastActivityTimestamp} + ${vaults.inactivityPeriod}) <= ${nowSeconds}`,
        eq(vaults.isRecovered, false),
        eq(vaults.isAbandoned, false),
        eq(vaults.isCancelled, false),
      ),
    )
    .limit(limit)
    .offset(offset);
}

/**
 * Returns a single vault record by chain + wallet address.
 * Returns undefined if the wallet is not registered on that chain.
 *
 * @param db      Drizzle client from createDbClient()
 * @param chainId Numeric EVM chain ID.
 * @param wallet  Wallet address (0x-prefixed, any case — compared case-insensitively)
 */
export async function getVaultByAddress(
  db: DbClient,
  chainId: number,
  wallet: string,
): Promise<Vault | undefined> {
  const result = await db
    .select()
    .from(vaults)
    .where(and(eq(vaults.chainId, chainId), sql`lower(${vaults.wallet}) = lower(${wallet})`))
    .limit(1);

  return result[0];
}

/**
 * Returns the total number of active (non-recovered, non-abandoned,
 * non-cancelled) vaults on the given chain. Used for monitoring and
 * logging in the keeper.
 *
 * @param db      Drizzle client from createDbClient()
 * @param chainId Numeric EVM chain ID.
 */
export async function getActiveVaultCount(db: DbClient, chainId: number): Promise<number> {
  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(vaults)
    .where(
      and(
        eq(vaults.chainId, chainId),
        eq(vaults.isRecovered, false),
        eq(vaults.isAbandoned, false),
        eq(vaults.isCancelled, false),
      ),
    );

  return result[0]?.count ?? 0;
}
