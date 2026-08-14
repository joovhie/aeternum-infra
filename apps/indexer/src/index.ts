/**
 * src/index.ts
 *
 * Core event mapping logic for the AeternumVault smart contract.
 * Listens for all 11 state-changing events and routes on-chain data directly
 * into the PostgreSQL tables defined in ponder.schema.ts.
 *
 * MULTI-CHAIN UPDATE: every handler now reads `context.chain.id` and uses
 * it to build vaults' composite `${chainId}-${wallet}` id, and stamps
 * `chainId` onto vault_transactions / balance_events rows too. Addresses
 * are also now consistently lowercased everywhere (previously only
 * balanceEvents.vaultId was) — worth doing while touching every handler
 * anyway, since a mixed-case id was a latent inconsistency even before
 * this change.
 *
 * `context.chain.id` is the current Ponder API for this (confirmed against
 * ponder.sh's docs) — worth a quick sanity check against the pinned
 * ponder@0.16.6's actual runtime behavior via `ponder dev` before trusting
 * this in production, since this is exactly the kind of API surface that
 * shifts between minor versions.
 */

import { ponder } from "ponder:registry";
import * as schema from "ponder:schema";

function vaultId(chainId: number, wallet: string): string {
  return `${chainId}-${wallet.toLowerCase()}`;
}

// --- 1. REGISTRATION ---
ponder.on("AeternumVault:RecoveryRegistered", async ({ event, context }) => {
  const chainId = context.chain.id;
  const wallet = event.args.wallet.toLowerCase();

  // Use onConflictDoUpdate to handle re-registrations (Upsert)
  await context.db.insert(schema.vaults).values({
    id: vaultId(chainId, wallet),
    chainId,
    wallet,
    backupAddress: event.args.backupAddress,
    inactivityPeriod: event.args.inactivityPeriod,
    lastActivityTimestamp: event.block.timestamp,
    isRecovered: false,
    isAbandoned: false,
    isCancelled: false,
    createdAtBlock: event.block.number,
  }).onConflictDoUpdate({
    backupAddress: event.args.backupAddress,
    inactivityPeriod: event.args.inactivityPeriod,
    lastActivityTimestamp: event.block.timestamp,
    isRecovered: false,
    isAbandoned: false,
    isCancelled: false,
    createdAtBlock: event.block.number,
  });

  // Added to unified ledger
  await context.db.insert(schema.vaultTransactions).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    chainId,
    wallet,
    type: "REGISTERED",
    transactionHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
  });
});

// --- 2. ACTIVITY & CONFIG UPDATES ---
ponder.on("AeternumVault:ActivityPinged", async ({ event, context }) => {
  const chainId = context.chain.id;
  const wallet = event.args.wallet.toLowerCase();

  await context.db.update(schema.vaults, { id: vaultId(chainId, wallet) }).set({
    lastActivityTimestamp: event.args.timestamp,
  });

  // Added to unified ledger
  await context.db.insert(schema.vaultTransactions).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    chainId,
    wallet,
    type: "PING",
    transactionHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
  });
});

ponder.on("AeternumVault:BackupAddressUpdated", async ({ event, context }) => {
  const chainId = context.chain.id;
  const wallet = event.args.wallet.toLowerCase();

  await context.db.update(schema.vaults, { id: vaultId(chainId, wallet) }).set({
    backupAddress: event.args.newBackupAddress,
    lastActivityTimestamp: event.block.timestamp,
  });

  // Added to unified ledger
  await context.db.insert(schema.vaultTransactions).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    chainId,
    wallet,
    type: "BACKUP_UPDATED",
    transactionHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
  });
});

ponder.on("AeternumVault:InactivityPeriodUpdated", async ({ event, context }) => {
  const chainId = context.chain.id;
  const wallet = event.args.wallet.toLowerCase();

  await context.db.update(schema.vaults, { id: vaultId(chainId, wallet) }).set({
    inactivityPeriod: event.args.newPeriod,
    lastActivityTimestamp: event.block.timestamp,
  });

  // Added to unified ledger
  await context.db.insert(schema.vaultTransactions).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    chainId,
    wallet,
    type: "PERIOD_UPDATED",
    transactionHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
  });
});

// --- 3. FINANCIAL TRANSACTIONS ---
ponder.on("AeternumVault:Deposited", async ({ event, context }) => {
  const chainId = context.chain.id;
  const wallet = event.args.wallet.toLowerCase();

  await context.db.update(schema.vaults, { id: vaultId(chainId, wallet) }).set({
    lastActivityTimestamp: event.block.timestamp,
  });

  await context.db.insert(schema.vaultTransactions).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    chainId,
    wallet,
    type: "DEPOSIT",
    amount: event.args.amount,
    transactionHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
  });

  // Chart Ledger Update
  await context.db.insert(schema.balanceEvents).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    chainId,
    vaultId: wallet,
    eventName: "Deposited",
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    blockTimestamp: event.block.timestamp,
    amount: event.args.amount,
  });
});

ponder.on("AeternumVault:Sent", async ({ event, context }) => {
  const chainId = context.chain.id;
  const wallet = event.args.wallet.toLowerCase();

  await context.db.update(schema.vaults, { id: vaultId(chainId, wallet) }).set({
    lastActivityTimestamp: event.block.timestamp,
  });

  await context.db.insert(schema.vaultTransactions).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    chainId,
    wallet,
    type: "SENT",
    amount: event.args.amount,
    toAddress: event.args.to, // Renamed from recipient
    transactionHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
  });

  // Chart Ledger Update
  await context.db.insert(schema.balanceEvents).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    chainId,
    vaultId: wallet,
    eventName: "Sent",
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    blockTimestamp: event.block.timestamp,
    amount: event.args.amount,
  });
});

ponder.on("AeternumVault:Withdrawn", async ({ event, context }) => {
  const chainId = context.chain.id;
  const wallet = event.args.wallet.toLowerCase();

  await context.db.update(schema.vaults, { id: vaultId(chainId, wallet) }).set({
    lastActivityTimestamp: event.block.timestamp,
  });

  await context.db.insert(schema.vaultTransactions).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    chainId,
    wallet,
    type: "WITHDRAWAL",
    amount: event.args.amount,
    transactionHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
  });

  // Chart Ledger Update
  await context.db.insert(schema.balanceEvents).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    chainId,
    vaultId: wallet,
    eventName: "Withdrawn",
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    blockTimestamp: event.block.timestamp,
    amount: event.args.amount,
  });
});

// --- 4. RECOVERY LIFECYCLE ---
ponder.on("AeternumVault:RecoveryExecuted", async ({ event, context }) => {
  const chainId = context.chain.id;
  const wallet = event.args.wallet.toLowerCase();

  await context.db.update(schema.vaults, { id: vaultId(chainId, wallet) }).set({
    isRecovered: true,
  });

  // Moved from recoveryEvents to unified ledger
  await context.db.insert(schema.vaultTransactions).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    chainId,
    wallet,
    type: "RECOVERY_EXECUTED",
    toAddress: event.args.backupAddress, // Maps backup address to recipient field
    amount: event.args.amount,
    transactionHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
  });

  // Chart Ledger Update
  await context.db.insert(schema.balanceEvents).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    chainId,
    vaultId: wallet,
    eventName: "RecoveryExecuted",
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    blockTimestamp: event.block.timestamp,
    amount: event.args.amount,
  });
});

ponder.on("AeternumVault:RecoveryFailed", async ({ event, context }) => {
  const chainId = context.chain.id;
  const wallet = event.args.wallet.toLowerCase();

  // Moved from recoveryEvents to unified ledger
  await context.db.insert(schema.vaultTransactions).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    chainId,
    wallet,
    type: "RECOVERY_FAILED",
    amount: event.args.amount,
    transactionHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
  });
});

ponder.on("AeternumVault:RecoveryAbandoned", async ({ event, context }) => {
  const chainId = context.chain.id;
  const wallet = event.args.wallet.toLowerCase();

  await context.db.update(schema.vaults, { id: vaultId(chainId, wallet) }).set({
    isAbandoned: true,
  });

  // Moved from recoveryEvents to unified ledger
  await context.db.insert(schema.vaultTransactions).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    chainId,
    wallet,
    type: "RECOVERY_ABANDONED",
    amount: event.args.balance,
    transactionHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
  });
});

ponder.on("AeternumVault:RecoveryCancelled", async ({ event, context }) => {
  const chainId = context.chain.id;
  const wallet = event.args.wallet.toLowerCase();

  // Update vault state to reflect cancellation
  await context.db.update(schema.vaults, { id: vaultId(chainId, wallet) }).set({
    isCancelled: true,
  });

  // Moved from recoveryEvents to unified ledger
  await context.db.insert(schema.vaultTransactions).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    chainId,
    wallet,
    type: "RECOVERY_CANCELLED",
    amount: event.args.refundAmount,
    transactionHash: event.transaction.hash,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
  });

  // Chart Ledger Update
  await context.db.insert(schema.balanceEvents).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    chainId,
    vaultId: wallet,
    eventName: "RecoveryCancelled",
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    blockTimestamp: event.block.timestamp,
    amount: event.args.refundAmount,
  });
});
