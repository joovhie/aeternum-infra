/**
 * src/indexerReads/queries.ts
 *
 * Read-only queries against the Ponder-managed tables (vaults,
 * vault_transactions) via @aeternum/db, for scoring purposes only.
 * Campaign never writes to these tables — only Ponder does.
 *
 * MULTI-CHAIN UPDATE: apps/indexer now stamps chainId on every row, and
 * packages/db's getDueVaults/getVaultByAddress/getActiveVaultCount all
 * require it — see the build plan's "existing files this touches" note,
 * now resolved. Every function below takes a chainId and filters on it,
 * so Sepolia-phase and mainnet-phase scoring can never accidentally read
 * each other's activity.
 */

import { and, eq, gte, sql } from "drizzle-orm";
import type { DbClient } from "@aeternum/db";
import { vaults, vaultTransactions } from "@aeternum/db";

/** All vault_transactions rows for a wallet on a given chain, optionally since a given unix timestamp (for incremental nightly scoring). */
export async function getTransactionsForWallet(
  db: DbClient,
  chainId: number,
  wallet: string,
  sinceUnixSeconds?: bigint,
) {
  return db
    .select()
    .from(vaultTransactions)
    .where(
      and(
        eq(vaultTransactions.chainId, chainId),
        sql`lower(${vaultTransactions.wallet}) = lower(${wallet})`,
        sinceUnixSeconds !== undefined ? gte(vaultTransactions.timestamp, sinceUnixSeconds) : undefined,
      ),
    );
}

/** All vault_transactions of a given type on a given chain, since a timestamp — the primary feed for the nightly scoring job. */
export async function getTransactionsByType(
  db: DbClient,
  chainId: number,
  type: string,
  sinceUnixSeconds: bigint,
) {
  return db
    .select()
    .from(vaultTransactions)
    .where(
      and(
        eq(vaultTransactions.chainId, chainId),
        eq(vaultTransactions.type, type),
        gte(vaultTransactions.timestamp, sinceUnixSeconds),
      ),
    );
}

/** Every currently-registered vault on a given chain that hasn't recovered, been abandoned, or been cancelled — the population the monthly liveness checkpoint runs over. Always called with the mainnet chain id — liveness is a mainnet-only concept. */
export async function getLiveVaults(db: DbClient, chainId: number) {
  return db
    .select()
    .from(vaults)
    .where(
      and(
        eq(vaults.chainId, chainId),
        eq(vaults.isRecovered, false),
        eq(vaults.isAbandoned, false),
        eq(vaults.isCancelled, false),
      ),
    );
}

/**
 * Checks whether a wallet's deposit around `atTimestamp` was withdrawn or
 * sent out again within `minHoldSeconds` afterward — the anti-gaming check
 * behind CAMPAIGN_MIN_HOLD_SECONDS. A crude but honest heuristic: it looks
 * for ANY WITHDRAWAL/SENT event in the window, not specifically one that
 * matches the deposited amount. Good enough to catch deposit-and-immediately-
 * withdraw farming; not a precise accounting reconciliation.
 */
export async function hadEarlyWithdrawal(
  db: DbClient,
  chainId: number,
  wallet: string,
  atTimestamp: bigint,
  minHoldSeconds: number,
): Promise<boolean> {
  const windowEnd = atTimestamp + BigInt(minHoldSeconds);

  const rows = await db
    .select()
    .from(vaultTransactions)
    .where(
      and(
        eq(vaultTransactions.chainId, chainId),
        sql`lower(${vaultTransactions.wallet}) = lower(${wallet})`,
        sql`${vaultTransactions.type} in ('WITHDRAWAL', 'SENT')`,
        gte(vaultTransactions.timestamp, atTimestamp),
        sql`${vaultTransactions.timestamp} <= ${windowEnd}`,
      ),
    )
    .limit(1);

  return rows.length > 0;
}
