/**
 * src/indexerReads/queries.ts
 *
 * Read-only queries against the Ponder-managed tables (vaults,
 * vault_transactions) via @aeternum/db, for scoring purposes only.
 * Campaign never writes to these tables — only Ponder does.
 *
 * IMPORTANT — multi-chain caveat: as of this writing, apps/indexer only
 * indexes Sepolia, and vaults.id is the bare wallet address with no chain
 * discriminator (see the build plan's "existing files this touches"
 * section). These queries will need a chainId filter added the moment
 * mainnet indexing goes live, or Sepolia and mainnet activity for the same
 * wallet will be indistinguishable here. Not fixed in this pass —
 * tracked as a follow-up against apps/indexer/ponder.schema.ts.
 */

import { and, eq, gte, sql } from "drizzle-orm";
import type { DbClient } from "@aeternum/db";
import { vaults, vaultTransactions } from "@aeternum/db";

/** All vault_transactions rows for a wallet, optionally since a given unix timestamp (for incremental nightly scoring). */
export async function getTransactionsForWallet(
  db: DbClient,
  wallet: string,
  sinceUnixSeconds?: bigint,
) {
  return db
    .select()
    .from(vaultTransactions)
    .where(
      and(
        sql`lower(${vaultTransactions.wallet}) = lower(${wallet})`,
        sinceUnixSeconds !== undefined ? gte(vaultTransactions.timestamp, sinceUnixSeconds) : undefined,
      ),
    );
}

/** All vault_transactions of a given type across every wallet, since a timestamp — the primary feed for the nightly scoring job. */
export async function getTransactionsByType(
  db: DbClient,
  type: string,
  sinceUnixSeconds: bigint,
) {
  return db
    .select()
    .from(vaultTransactions)
    .where(and(eq(vaultTransactions.type, type), gte(vaultTransactions.timestamp, sinceUnixSeconds)));
}

/** Every currently-registered vault that hasn't recovered, been abandoned, or been cancelled — the population the monthly liveness checkpoint runs over. */
export async function getLiveVaults(db: DbClient) {
  return db
    .select()
    .from(vaults)
    .where(and(eq(vaults.isRecovered, false), eq(vaults.isAbandoned, false), eq(vaults.isCancelled, false)));
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
        sql`lower(${vaultTransactions.wallet}) = lower(${wallet})`,
        sql`${vaultTransactions.type} in ('WITHDRAWAL', 'SENT')`,
        gte(vaultTransactions.timestamp, atTimestamp),
        sql`${vaultTransactions.timestamp} <= ${windowEnd}`,
      ),
    )
    .limit(1);

  return rows.length > 0;
}
