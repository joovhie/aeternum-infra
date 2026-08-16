/**
 * src/scanner.ts
 *
 * Identifies vaults due for recovery using a two-layer approach:
 *
 *   Layer 1 — DB pre-filter (free, no RPC):
 *     Queries the Ponder-indexed database for vaults where
 *     lastActivityTimestamp + inactivityPeriod <= now AND not yet
 *     recovered, abandoned, or cancelled. Fast and cheap, but may lag
 *     a few blocks behind the chain head.
 *
 *   Layer 2 — Onchain validation (one multicall, no per-vault RPC):
 *     Calls isRecoveryDue(wallet) for every DB candidate in a single
 *     eth_call via viem's multicall. Catches any stale DB entries before
 *     a transaction is ever submitted.
 *
 * The contract re-validates all conditions independently inside
 * _executeRecovery — this scanner is an efficiency layer, not a
 * security boundary. If validation logic ever drifts, the contract
 * is always the final arbiter.
 *
 * MULTI-CHAIN UPDATE: getDueVaults now requires a chainId and returns
 * rows keyed by a composite id (`${chainId}-${wallet}`) — candidates are
 * now built from row.wallet, not row.id. Previously this cast row.id
 * directly to an address, which silently breaks the moment vaults.id
 * stops being the bare wallet address.
 */

import { AETERNUM_VAULT_ABI, type ViemPublicClient } from "@aeternum/blockchain";
import { getDueVaults, type DbClient } from "@aeternum/db";
import { logger } from "./logger.js";

export type Address = `0x${string}`;

type IsRecoveryDueResult =
  | { status: "success"; result: boolean }
  | { status: "failure"; result?: undefined }

/**
 * Scans for vaults due for recovery and returns a confirmed list of
 * wallet addresses ready for triggerRecovery submission.
 *
 * @param db              Drizzle DB client (read-only).
 * @param chainId         Chain this keeper deployment operates on
 *                        (env.CHAIN_ID). A keeper only ever scans and
 *                        acts on its own chain.
 * @param publicClient    Viem public client for onchain validation.
 * @param contractAddress AeternumVault contract address.
 * @param dbScanLimit     Max candidates to pull from DB per cycle.
 *                        Callers should pass env.KEEPER_BATCH_SIZE.
 */
export async function scan(
  db: DbClient,
  chainId: number,
  publicClient: ViemPublicClient,
  contractAddress: Address,
  dbScanLimit: number,
): Promise<Address[]> {
  // --- Layer 1: DB pre-filter ---
  let candidates: Address[];

  try {
    const rows = await getDueVaults(db, chainId, dbScanLimit);
    candidates = rows.map((r) => r.wallet as Address);
  } catch (err) {
    logger.error("Scanner: DB query failed, skipping cycle", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  if (candidates.length === 0) {
    return [];
  }

  logger.info("Scanner: DB candidates found", { count: candidates.length });

  // --- Layer 2: Onchain validation
  // viem's multicall batches all isRecoveryDue reads into a single eth_call.
  let results: IsRecoveryDueResult[] = [];

  try {
    results = await publicClient.multicall({
      contracts: candidates.map((wallet) => ({
        address: contractAddress,
        abi: AETERNUM_VAULT_ABI,
        functionName: "isRecoveryDue" as const,
        args: [wallet] as const,
      })),
      allowFailure: true,
    }) as IsRecoveryDueResult[];
  } catch (err) {
    logger.error("Scanner: onchain validation failed, skipping cycle", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  const confirmed = candidates.filter((_, i) => {
    const result = results[i];
    return result?.status === "success" && result.result === true;
  });

  const stale = candidates.length - confirmed.length;

  if (stale > 0) {
    logger.info("Scanner: stale DB entries filtered out", { stale });
  }

  logger.info("Scanner: onchain-confirmed due vaults", { count: confirmed.length });

  return confirmed;
}
