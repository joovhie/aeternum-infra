/**
 * ponder.schema.ts
 *
 * Database schema definition for the Aeternum protocol indexer.
 * Establishes the relational structure for core vault states, financial
 * ledgers, and the automated recovery lifecycle.
 *
 * MULTI-CHAIN UPDATE: `vaults.id` used to be the bare wallet address. Once
 * this indexer tracks mainnet alongside Sepolia, the same wallet address
 * registering on both chains would collide on that id — a mainnet
 * registration would silently overwrite the Sepolia row via
 * onConflictDoUpdate in src/index.ts. `id` is now `${chainId}-${wallet}`,
 * with `chainId` and `wallet` broken out as their own columns so callers
 * don't need to parse the composite id back apart. `vault_transactions`
 * and `balance_events` keep their existing id shape (txHash-logIndex is
 * already chain-unique in practice) but gain a `chainId` column too, since
 * nothing about their existing ids reveals which chain a row came from —
 * without it, mixed sepolia/mainnet data becomes unfilterable.
 */

import { onchainTable } from "ponder";

// 1. Core Vault Entity
export const vaults = onchainTable("vaults", (t) => ({
  id: t.text().primaryKey(), // `${chainId}-${walletAddress}`, both lowercased
  chainId: t.integer().notNull(),
  wallet: t.text().notNull(), // bare wallet address — query this instead of parsing `id`
  backupAddress: t.text().notNull(),
  inactivityPeriod: t.bigint().notNull(),
  lastActivityTimestamp: t.bigint().notNull(),
  isRecovered: t.boolean().notNull().default(false),
  isAbandoned: t.boolean().notNull().default(false),
  isCancelled: t.boolean().notNull().default(false),
  createdAtBlock: t.bigint().notNull(),
}));

// 2. Unified Vault Transactions Log
// Handles BOTH financial events (Deposits/Sends) AND lifecycle events (Pings/Recovery)
export const vaultTransactions = onchainTable("vault_transactions", (t) => ({
  id: t.text().primaryKey(), // unique hash + log index
  chainId: t.integer().notNull(),
  wallet: t.text().notNull(),
  type: t.text().notNull(), // "DEPOSIT", "WITHDRAWAL", "SENT", "PING", "REGISTERED", "RECOVERY_EXECUTED", etc.

  // These fields are nullable because a "PING" has no amount or toAddress
  amount: t.bigint(),
  toAddress: t.text(), // Renamed from 'recipient' to match frontend GraphQL

  // New fields required by the frontend UI
  transactionHash: t.text().notNull(),
  blockNumber: t.bigint().notNull(),
  timestamp: t.bigint().notNull(),
}));

// 3. Unified Balance Ledger (For Charting)
export const balanceEvents = onchainTable("balance_events", (t) => ({
  id: t.text().primaryKey(), // unique hash + log index
  chainId: t.integer().notNull(),
  vaultId: t.text().notNull(), // The wallet address, named to match GraphQL query — unchanged, still the bare wallet (not the new composite vaults.id) so existing frontend queries by wallet keep working
  eventName: t.text().notNull(), // "Deposited", "Sent", "Withdrawn", "RecoveryExecuted", "RecoveryCancelled"
  blockNumber: t.bigint().notNull(),
  logIndex: t.integer().notNull(),
  blockTimestamp: t.bigint().notNull(),
  amount: t.bigint(), // Nullable for events that wipe the balance without a specific delta
}));
